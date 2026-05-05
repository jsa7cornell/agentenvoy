/**
 * Composer-modules architecture — type declarations.
 *
 * Per proposal `2026-05-04_composer-modules-architecture_*_decided-2026-05-04.md`
 * §1.4 (Component vocabulary) + §2.2 (The module bundle).
 *
 * - **Module** = declarative data (a typed bundle); not code that runs.
 * - **Runner** = the orchestrator function `runModule(input)` that reads a
 *   module and operates the Composer layer (Rule 17 layer 3).
 * - **Composer** = the Sonnet LLM call inside `runModule`'s step 3 (NOT this file).
 *
 * PR1a is the construct's entry: types + runner + _shared/post-stream-guards
 * + a no-op `chat` smoke module. Modules + bench fixtures for `rule`,
 * `bookings`, etc. ship in subsequent PRs (PR1c, PR4, PR5).
 */
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Surface + style
// ---------------------------------------------------------------------------

/** Where a message or tool call arrives. Routes are thin shims, not stages. */
export type IntentSurface =
  | "dashboard-host"     // /api/channel/chat with role:host
  | "dealroom-host"      // /api/negotiate/message with isHost:true (PR5)
  | "dealroom-guest"     // /api/negotiate/message with isHost:false (PR5)
  | "mcp-tool";          // /api/mcp/host/* (PR6 — bookings module's MCP exposure)

/** Output shape for the runner's response. */
export type ResponseStyle = "human-prose" | "agent-concise";

// ---------------------------------------------------------------------------
// Module context (what the runner passes around)
// ---------------------------------------------------------------------------

/** Surface-keyed context that every module sees. The runner builds this once. */
export interface ModuleContext {
  user: { id: string; name: string | null; email: string };
  channel?: { id: string };                     // dashboard-host only
  session?: {                                    // dealroom-host / dealroom-guest only
    id: string;
    linkId: string;
    hostId: string;
  };
  surface: IntentSurface;
}

// ---------------------------------------------------------------------------
// Matcher output
// ---------------------------------------------------------------------------

export type MatchResult =
  | {
      kind: "deterministic";
      resolved: {
        sessionId?: string;
        linkCode?: string;
        ruleId?: string;
        freshCreate?: boolean;
        args?: Record<string, unknown>;
      };
      /** Per matcher Ni2: fragment selection signal for matcher-conditional playbooks. */
      playbookVariant?: string;
    }
  | {
      kind: "multi-match";
      candidates: Array<{ id: string; label: string }>;
      originatingIntent: string;
    }
  | { kind: "fall-through" };

// ---------------------------------------------------------------------------
// Context loader output (per-module shape; modules extend via TypeScript structural)
// ---------------------------------------------------------------------------

/**
 * Base shape every contextLoader returns. Modules extend this interface with
 * their own fields (e.g., `RuleContext` adds `recentRules`, `upcomingEvents`).
 *
 * The runner formats `contextLines` + `groundTruthBlock` into the system prompt.
 * Module-specific fields are passed to the module's preEmitChecks via
 * `contextOutput`, which is typed per-module.
 */
export interface ModuleContextOutput {
  /** Human-readable lines for the prompt's CONTEXT block. */
  contextLines: string[];
  /** Optional [GROUND TRUTH] block for state-grounding (e.g., F14 Phase 3.A). */
  groundTruthBlock?: string;
  /**
   * Optional dynamic content the runner inserts AFTER the playbook fragments
   * and BEFORE the # Context section. Used by event-intent modules
   * (PR3b-iii) to fold the matcher's deterministic-create hint into the
   * system prompt without polluting the static playbook fragment list. The
   * legacy schedule path's `system = systemBase + precheckHintBlock + "..."`
   * shape (chat/route.ts:1124-1127 pre-PR3b-iii) is preserved by this seam.
   */
  systemPromptSuffix?: string;
}

// ---------------------------------------------------------------------------
// Action shapes — re-export the canonical types from actions.ts
// ---------------------------------------------------------------------------

import type { ActionRequest, ActionResult } from "@/agent/actions";
export type { ActionRequest, ActionResult };

// ---------------------------------------------------------------------------
// Composer-callable tools (probabilistic — the LLM decides whether to call)
// ---------------------------------------------------------------------------

export interface ComposerTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType<Output>;
  /** Tool implementation. The runner wires `moduleContext` automatically. */
  execute: (input: Input, ctx: ModuleContext) => Promise<Output>;
}

/**
 * Type-erased ComposerTool used when collecting tools into a registry/list.
 * `z.ZodType<X>` is invariant in `X`, so a `ComposerTool<Specific, Specific>`
 * is not assignable to `ComposerTool<unknown, unknown>`. The "any/any" form
 * sidesteps the invariance — callers still get specific types at the
 * declaration site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyComposerTool = ComposerTool<any, any>;

// ---------------------------------------------------------------------------
// PreEmitCheck (deterministic; runs after composer emit, before action dispatch)
// ---------------------------------------------------------------------------

export interface PreEmitCheckArgs<C extends ModuleContextOutput = ModuleContextOutput> {
  parsedActions: ActionRequest[];
  contextOutput: C;
  moduleContext: ModuleContext;
}

export interface PreEmitCheckResult {
  flaggedReason: string;
  /** Retry hint sent to the composer as the next user turn. */
  hint: string;
  /** Per N3: shipped instead of action when severity=blocking AND retries exhaust. */
  fallbackProse?: string;
}

export interface PreEmitCheck<C extends ModuleContextOutput = ModuleContextOutput> {
  name: string;
  /**
   * Per N3: "advisory" exhausts → ship original; "blocking" exhausts → ship
   * `fallbackProse`, skip action emission entirely.
   */
  severity: "advisory" | "blocking";
  check: (args: PreEmitCheckArgs<C>) => Promise<PreEmitCheckResult | null>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPreEmitCheck = PreEmitCheck<any>;

// ---------------------------------------------------------------------------
// PostStreamGuard (deterministic prose-pattern check; runs on full text)
// ---------------------------------------------------------------------------

export interface PostStreamGuardArgs {
  text: string;
  parsedActions: ActionRequest[];
  moduleContext: ModuleContext;
}

export interface PostStreamGuardResult {
  flaggedReason: string;
  hint: string;
}

export interface PostStreamGuard {
  name: string;
  check: (args: PostStreamGuardArgs) => PostStreamGuardResult | null;
}

// ---------------------------------------------------------------------------
// IntentModule (the declarative bundle)
// ---------------------------------------------------------------------------

export interface IntentModule<C extends ModuleContextOutput = ModuleContextOutput> {
  /** Closed-set intent name. Per surface, the intent set differs. */
  intent: string;
  surface: IntentSurface;
  description: string;

  /**
   * Playbook fragment paths under `app/src/agent/runtime-prompts/`.
   * Composed in order with `---` separators into the composer's system prompt.
   * Per file-tracing invariant (B4): every fragment path is intended to be
   * inlined as a literal `readFileSync(join(cwd, "literal/path"))` because
   * Vercel's `@vercel/nft` traces statically. PR1a's runner uses a dynamic
   * loader; subsequent PRs (when bundling matters for production) generate
   * per-fragment named exports at build time.
   *
   * Static for most modules; can be a function for matcher-conditional
   * composition (Ni2 — e.g., rule module loads `add` vs `update` fragment
   * based on `matchResult.playbookVariant`).
   */
  composerPlaybook: readonly string[] | ((match: MatchResult) => readonly string[]);

  contextLoader: (
    moduleContext: ModuleContext,
    matchResult: MatchResult,
    userMessage: string,
  ) => Promise<C>;

  /** Composer-callable tools (probabilistic — the LLM decides whether to call). */
  composerTools?: readonly AnyComposerTool[];

  /**
   * Deterministic checks that run after the composer emits, before action dispatch.
   * Per F14 absorption: state-aware checks (fabricated id, link code, conflict-shadow).
   */
  preEmitChecks?: readonly AnyPreEmitCheck[];

  /**
   * Deterministic prose-pattern guards.
   * Default: Layer 2a + 2b + F6 from `_shared/post-stream-guards/` (auto-injected
   * unless `useDefaultPostStreamGuards: false` per Ni4).
   */
  postStreamGuards: readonly PostStreamGuard[];

  /**
   * Whether to auto-inject the Layer 2a/2b/F6 default guards.
   * Default: true. Set to false to opt out completely (e.g., inquire-tier
   * modules that forbid actions outright).
   */
  useDefaultPostStreamGuards?: boolean;

  /** Closed set of action types this module may emit. Runner strips out-of-bounds. */
  allowedActions: readonly string[];

  responseStyle: ResponseStyle;

  /** Bucket name for moduleGuard corpus segmentation. Stable; do not rename per Rule 25(l). */
  moduleGuardBucket: string;
}

// ---------------------------------------------------------------------------
// Composer invocation interface (DI seam for tests + bench)
// ---------------------------------------------------------------------------

/**
 * The composer (Sonnet LLM) call abstracted as a function. The runner calls
 * this; tests + bench inject mocks. Production wiring uses the live Sonnet
 * gateway via `lib/model.ts`.
 *
 * This is the cleanest seam for testing — the runner's logic (context-load
 * + prompt-compose + action-parse + retry orchestration) is pure code; only
 * the actual LLM call needs to be mocked. Per N5: replaces the spike's
 * `__SPIKE_LLM_OVERRIDE` with proper DI.
 */
export interface ComposerInvoker {
  (args: {
    systemPrompt: string;
    history: Array<{ role: string; content: string }>;
    userMessage: string;
    tools: readonly AnyComposerTool[] | undefined;
    moduleContext: ModuleContext;
  }): Promise<{
    text: string;
    toolCalls?: Array<{ name: string; durationMs: number; success: boolean }>;
  }>;
}

// ---------------------------------------------------------------------------
// Runner I/O
// ---------------------------------------------------------------------------

export interface RunnerInput {
  surface: IntentSurface;
  intent: string;
  moduleContext: ModuleContext;
  matchResult: MatchResult;
  userMessage: string;
  conversationHistory: Array<{ role: string; content: string }>;
  /** Per M1: streaming for path C; PR1a ships buffered-only. */
  streaming?: boolean;
  /**
   * Optional composer invoker override. Production code omits this and the
   * runner uses the default Sonnet invoker. Tests + bench fixtures pass mocks.
   */
  composerInvoker?: ComposerInvoker;
  /**
   * Optional action-execution timeout in ms. When set, the runner races
   * `executeActions(parsedActions)` against `setTimeout(timeoutMs)`. On
   * timeout, the runner returns `actionsTimedOut: true` and logs the late
   * completion in the background. PR3b-iii adopts the legacy schedule path's
   * 15s default for event intents.
   */
  actionTimeoutMs?: number;
  /**
   * Called by the runner each time it is about to retry the composer after a
   * guard fires. Allows the caller (dispatchModuleAndStream) to emit a
   * `retrying` status frame to the client so the user sees progress.
   * Parity with legacy-route.ts:1220 which emitted `retrying` from the route.
   */
  onRetry?: () => void;
}

export interface ModuleGuardRecord {
  bucket: string;
  guardsFired: Array<{ name: string; phase: "preEmit" | "postStream"; flaggedReason: string }>;
  retryCount: 0 | 1 | 2;
  retrySucceeded: boolean | null;               // null when no retries
  exhaustedRetries: boolean;
  /** Per N3: blocking exhaustion → action emission was skipped, fallbackProse shipped. */
  blockingFallbackShipped?: { checkName: string; prose: string };
  toolCalls: Array<{ name: string; durationMs: number; success: boolean }>;
}

export type RunnerOutput =
  | {
      kind: "buffered";
      text: string;
      parsedActions: ActionRequest[];
      actionResults: ActionResult[];
      moduleGuard: ModuleGuardRecord;
      /** Exposed for tests + bench inspection. */
      systemPrompt: string;
      /** PR3b-iii: action-execution exceeded `actionTimeoutMs`. The late
       *  completion is logged in the background; actionResults is empty. */
      actionsTimedOut?: boolean;
    }
  | {
      kind: "streaming";
      stream: ReadableStream<Uint8Array>;
      onFinish: Promise<{
        text: string;
        parsedActions: ActionRequest[];
        actionResults: ActionResult[];
        moduleGuard: ModuleGuardRecord;
        systemPrompt: string;
      }>;
    };

// ---------------------------------------------------------------------------
// Module registry — keyed by (surface, intent)
// ---------------------------------------------------------------------------

export type ModuleRegistry = {
  readonly [S in IntentSurface]?: { readonly [intent: string]: IntentModule };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per M6: max retries per turn (shared across pre/post guard phases). */
export const MAX_RETRIES_PER_TURN = 2;
