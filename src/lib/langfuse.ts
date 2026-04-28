/**
 * Langfuse SDK wrapper — dev-time observability for the agent prompt path.
 *
 * Behavior contract:
 *   - When `LANGFUSE_ENABLED !== "true"`, every export is a no-op.
 *   - When enabled, exports a single shared client (lazy-init) + helpers
 *     (`startTrace`, `recordSpan`) that callers in composer.ts and
 *     intent-classifier.ts use to mark prompt-path entries.
 *   - Production (Vercel) defaults to disabled; the env var is set only
 *     on dev machines that have docker-compose.langfuse.yml running.
 *
 * Why this exists:
 *   Provides ad-hoc trace inspection during prompt iteration. NOT a
 *   replacement for the Promptfoo CI eval (that's regression-catching;
 *   this is interactive debugging). See archive/refactor-package-2026-04-25/
 *   CODEBASE-CLEANUP.md item 9 for the Promptfoo/Langfuse split rationale.
 *
 * Production-safety design:
 *   - The `langfuse` package is a `devDependencies`-only entry. Importing
 *     it at module top-level would fail in production (`next build`
 *     bundles only `dependencies`). Instead, this wrapper uses dynamic
 *     `import()` inside a try/catch, so the SDK is loaded lazily on
 *     first enabled call and silently absent otherwise.
 *   - Every public function is a no-op when `LANGFUSE_ENABLED` is unset.
 *     Callers in composer.ts / intent-classifier.ts can wrap LLM calls
 *     unconditionally; production sees zero overhead.
 *   - If the SDK ever fails to load OR a call to it throws, we swallow
 *     the error and return the plain function result. Instrumentation
 *     must NEVER break the request path.
 *
 * What this wrapper does NOT do:
 *   - No automatic trace flushing on process exit (Langfuse SDK already
 *     flushes on `flushAsync`, not configured here — this is dev-only,
 *     leaving traces hanging in memory between dev reloads is fine).
 *   - No prompt-versioning / dataset registration. Those are Phase 5
 *     PR-3+ concerns.
 *   - No production telemetry hosting. Per CODEBASE-CLEANUP item 9,
 *     production tracing is deferred — a wishlist item if/when scale
 *     demands shared inspection.
 */

// ---- Env-flag check ---------------------------------------------------------

/**
 * True when `process.env.LANGFUSE_ENABLED === "true"`. Strict equality on
 * the string literal — any other value (unset, "false", "1", etc.) is off.
 * Production deploy on Vercel does not set this variable.
 */
export function langfuseEnabled(): boolean {
  return process.env.LANGFUSE_ENABLED === "true";
}

// ---- Lazy SDK loader --------------------------------------------------------

// We do NOT statically import `langfuse`. The package is a devDependency only;
// `next build` excludes devDependencies from the production bundle, so a
// top-level import would fail at build time. Loading dynamically inside the
// enabled-only paths keeps production builds clean.

// Cached singleton — null when disabled OR when the SDK failed to load.
// `undefined` means "not yet attempted"; `null` means "tried, failed or
// disabled". The distinction matters so we don't re-attempt the import on
// every call after a failure.
let cachedClient: unknown | null | undefined = undefined;

// Minimal structural types — we don't import the real ones because that
// would force a hard dependency on `langfuse`. If the SDK changes its
// API shape, this wrapper will fail loudly the next time a dev runs with
// LANGFUSE_ENABLED=true; production stays unaffected.
interface LangfuseLike {
  trace(body: { name: string; metadata?: Record<string, unknown> }): TraceClientLike;
  flushAsync?: () => Promise<void>;
}
interface TraceClientLike {
  span(body: {
    name: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
  }): SpanClientLike;
  update(body: Record<string, unknown>): TraceClientLike;
}
interface SpanClientLike {
  end(body?: { output?: unknown; metadata?: Record<string, unknown> }): SpanClientLike;
}

/**
 * Lazily load the Langfuse SDK and instantiate a singleton client. Returns
 * null if disabled OR if the SDK failed to load. Synchronous from the
 * caller's perspective — the dynamic import happens once and the resolved
 * module is cached. To keep this synchronous (callers shouldn't have to
 * `await getLangfuseClient()`), we use a module-level eager dynamic import
 * fired exactly once on the first enabled call. While the import resolves,
 * `cachedClient` stays `undefined` and helpers fall through to no-op —
 * acceptable for dev-time observability where the first ~50ms of a fresh
 * process miss tracing.
 */
export function getLangfuseClient(): LangfuseLike | null {
  if (!langfuseEnabled()) {
    return null;
  }
  if (cachedClient === null) {
    return null;
  }
  if (cachedClient !== undefined) {
    return cachedClient as LangfuseLike;
  }
  // First call with the flag on — kick off the import. Mark cachedClient as
  // null pre-emptively so concurrent callers fall through during the resolve
  // window; the resolved promise will overwrite it.
  cachedClient = null;
  // Vite/Next dynamic-import resolution — wrapped so a failed import never
  // throws synchronously. We attach `.then` and don't await to keep the
  // caller synchronous; the cached value is updated on resolve.
  // Dynamic import — the module specifier is a runtime string so the bundler
  // does not try to statically include it in production output.
  const moduleSpecifier = "langfuse";
  import(/* webpackIgnore: true */ /* @vite-ignore */ moduleSpecifier)
    .then((mod: { Langfuse?: new (opts: Record<string, unknown>) => LangfuseLike }) => {
      const Ctor = mod?.Langfuse;
      if (typeof Ctor !== "function") {
        // SDK shape changed or import returned the wrong thing. Stay null.
        cachedClient = null;
        return;
      }
      try {
        cachedClient = new Ctor({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl: process.env.LANGFUSE_HOST ?? "http://localhost:3001",
        });
      } catch (e) {
        // Construction failed (bad keys, host unreachable). Log once at debug
        // level — dev-only, production never reaches this branch.
        console.warn("[langfuse] client construction failed; tracing disabled:", e);
        cachedClient = null;
      }
    })
    .catch((e) => {
      console.warn("[langfuse] dynamic import failed; tracing disabled:", e);
      cachedClient = null;
    });
  return null;
}

// ---- Public helpers ---------------------------------------------------------

/**
 * Thin wrapper around a `LangfuseTraceClient` that callers can use to mark
 * sub-observations within a single prompt-path turn. `null` when Langfuse
 * is disabled — callers null-check and proceed without tracing.
 */
export interface TraceHandle {
  /** Record a child observation under this trace. */
  observation(name: string, input?: unknown, output?: unknown): void;
  /** Mark the trace ended. Idempotent. */
  end(): void;
}

/**
 * Open a new Langfuse trace. Returns null when disabled.
 *
 * The returned handle exposes a minimal surface — `observation()` for
 * sub-spans and `end()` to close. Full Langfuse Trace API is not exposed
 * because callers in composer.ts / intent-classifier.ts only need these
 * two operations. Add more methods here when a real caller needs them,
 * not pre-emptively.
 */
export function startTrace(
  name: string,
  metadata?: Record<string, unknown>,
): TraceHandle | null {
  if (!langfuseEnabled()) {
    return null;
  }
  const client = getLangfuseClient();
  if (!client) {
    return null;
  }
  let trace: TraceClientLike | null = null;
  try {
    trace = client.trace({ name, metadata });
  } catch (e) {
    console.warn(`[langfuse] startTrace(${name}) failed:`, e);
    return null;
  }
  let ended = false;
  return {
    observation(obsName, input, output) {
      if (!trace || ended) return;
      try {
        const span = trace.span({ name: obsName, input, output });
        span.end();
      } catch (e) {
        console.warn(`[langfuse] observation(${obsName}) failed:`, e);
      }
    },
    end() {
      if (!trace || ended) return;
      ended = true;
      // The TraceClientLike has no explicit end method — Langfuse traces
      // close implicitly. Provide a no-op for API symmetry; future SDK
      // changes can wire this up if needed.
    },
  };
}

/**
 * Wrap an async function with a Langfuse span. When Langfuse is disabled,
 * this falls through to a plain `await fn()` with zero overhead — the
 * production guarantee.
 *
 * Usage:
 *   const result = await recordSpan("intent-classifier.classify", async () => {
 *     return await generateObject({ ... });
 *   }, { hostName, sessionId });
 *
 * On error inside fn(), the span records the exception and rethrows. The
 * caller's try/catch behavior is preserved — instrumentation never
 * swallows or transforms exceptions.
 */
export async function recordSpan<T>(
  name: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  if (!langfuseEnabled()) {
    // Production path — zero overhead, byte-identical to calling fn() directly.
    return fn();
  }
  const client = getLangfuseClient();
  if (!client) {
    return fn();
  }
  let trace: TraceClientLike | null = null;
  let span: SpanClientLike | null = null;
  try {
    trace = client.trace({ name, metadata });
    span = trace.span({ name, metadata });
  } catch (e) {
    // SDK error during trace/span creation — fall through to plain fn().
    console.warn(`[langfuse] recordSpan(${name}) setup failed:`, e);
    return fn();
  }
  try {
    const result = await fn();
    try {
      span?.end({ output: { ok: true } });
    } catch (e) {
      console.warn(`[langfuse] recordSpan(${name}) end failed:`, e);
    }
    return result;
  } catch (err) {
    try {
      span?.end({
        output: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
    } catch (e) {
      console.warn(`[langfuse] recordSpan(${name}) error-end failed:`, e);
    }
    throw err;
  }
}

/**
 * Synchronous variant of `recordSpan` for sync work (e.g. prompt assembly
 * in `composer.ts:composeSystemPrompt`). Same fall-through guarantee:
 * disabled → plain `fn()`. Use this only when the wrapped work is genuinely
 * sync; for any await'd code, prefer `recordSpan` so latency lands on the
 * span correctly.
 *
 * Why a separate function: composer.ts assembles strings in-process — there
 * is no async work to wrap. Forcing the call site to be async would change
 * the function signature ("no composer behavior changes" per Phase 5 PR-1
 * mandate). A sync wrapper preserves the signature.
 */
export function recordSpanSync<T>(
  name: string,
  fn: () => T,
  metadata?: Record<string, unknown>,
): T {
  if (!langfuseEnabled()) {
    return fn();
  }
  const client = getLangfuseClient();
  if (!client) {
    return fn();
  }
  let trace: TraceClientLike | null = null;
  let span: SpanClientLike | null = null;
  try {
    trace = client.trace({ name, metadata });
    span = trace.span({ name, metadata });
  } catch (e) {
    console.warn(`[langfuse] recordSpanSync(${name}) setup failed:`, e);
    return fn();
  }
  try {
    const result = fn();
    try {
      span?.end({ output: { ok: true } });
    } catch (e) {
      console.warn(`[langfuse] recordSpanSync(${name}) end failed:`, e);
    }
    return result;
  } catch (err) {
    try {
      span?.end({
        output: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
    } catch (e) {
      console.warn(`[langfuse] recordSpanSync(${name}) error-end failed:`, e);
    }
    throw err;
  }
}
