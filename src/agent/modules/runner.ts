/**
 * Module runner — operates the Composer layer (Rule 17 layer 3).
 *
 * Per proposal §2.3 + §1.4 vocabulary. The runner is code; modules are data.
 * Step 3 inside `runModule` IS the Composer (Sonnet LLM call).
 *
 * PR1a: buffered mode only, no streaming. Streaming-mode lands in PR5b.
 *
 * Composer invocation is injected via `RunnerInput.composerInvoker` (or the
 * runner falls back to `defaultComposerInvoker`). This DI seam replaces the
 * spike's `__SPIKE_LLM_OVERRIDE` field — tests + bench fixtures pass mock
 * invokers; production code uses the default.
 */
import { generateText, tool, type Tool } from "ai";
import { readFileSync } from "fs";
import { join } from "path";
import { envoyModel } from "@/lib/model";
import { parseActions, stripActionBlocks, executeActions } from "@/agent/actions";
import type { ActionRequest, ActionResult } from "@/agent/actions";
import {
  type AnyComposerTool,
  type ComposerInvoker,
  type IntentModule,
  type MatchResult,
  type ModuleContext,
  type ModuleContextOutput,
  type ModuleGuardRecord,
  type RunnerInput,
  type RunnerOutput,
  MAX_RETRIES_PER_TURN,
} from "./types";
import { DEFAULT_POST_STREAM_GUARDS } from "./_shared/post-stream-guards";
import { lookupModule } from "./registry";

// ---------------------------------------------------------------------------
// Playbook fragment loading
// ---------------------------------------------------------------------------

/**
 * Loads a single playbook fragment from disk.
 *
 * Per the file-tracing invariant (B4): every fragment path is intended to be
 * inlined as a literal `readFileSync(join(cwd, "literal/path"))` because
 * Vercel's `@vercel/nft` traces statically. PR1a uses this dynamic loader
 * because we're iterating fragment paths during runtime; subsequent PRs
 * (when bundling matters for production traffic) generate per-fragment named
 * exports at build time.
 */
export function loadFragment(fragmentPath: string): string {
  const cwd = process.cwd();
  // fragmentPath is relative to app/src/agent/playbooks/ (e.g., "fragments/voice")
  const fullPath = join(cwd, "src", "agent", "playbooks", `${fragmentPath}.md`);
  return readFileSync(fullPath, "utf-8");
}

/**
 * Composes the system prompt from a module's playbook fragments + the loaded
 * context. Joins fragments with `---` separators, mirroring composer.ts:212.
 */
export function composeSystemPrompt(
  fragments: readonly string[],
  contextOutput: ModuleContextOutput,
  moduleContext: ModuleContext,
): string {
  const parts: string[] = [];
  for (const fragmentPath of fragments) {
    const content = loadFragment(fragmentPath);
    parts.push(content.trim());
  }

  // CONTEXT block: human-readable lines + ground-truth blocks the module loaded.
  const contextParts: string[] = [];
  contextParts.push(`User: ${moduleContext.user.name ?? "User"}`);
  if (contextOutput.contextLines.length > 0) {
    contextParts.push(...contextOutput.contextLines);
  }
  if (contextOutput.groundTruthBlock) {
    contextParts.push(contextOutput.groundTruthBlock);
  }
  parts.push(`# Context\n\n${contextParts.join("\n")}`);

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Default composer invoker — wraps Sonnet via gateway
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

function wireTools(
  composerTools: readonly AnyComposerTool[] | undefined,
  moduleContext: ModuleContext,
  toolCallLog: ModuleGuardRecord["toolCalls"],
): Record<string, Tool> | undefined {
  if (!composerTools || composerTools.length === 0) return undefined;
  const out: Record<string, Tool> = {};
  for (const t of composerTools) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (input: unknown) => {
        const start = Date.now();
        try {
          const result = await t.execute(input, moduleContext);
          toolCallLog.push({ name: t.name, durationMs: Date.now() - start, success: true });
          return result;
        } catch (e) {
          toolCallLog.push({ name: t.name, durationMs: Date.now() - start, success: false });
          throw e;
        }
      },
    });
  }
  return out;
}

/**
 * Production composer invoker. Calls Sonnet via the gateway. Used when
 * `RunnerInput.composerInvoker` is not provided.
 */
export const defaultComposerInvoker: ComposerInvoker = async ({
  systemPrompt,
  history,
  userMessage,
  tools: composerTools,
  moduleContext,
}) => {
  const toolCalls: ModuleGuardRecord["toolCalls"] = [];
  const tools = wireTools(composerTools, moduleContext, toolCalls);

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of history) {
    if (m.role === "user" || m.role === "host" || m.role === "guest") {
      messages.push({ role: "user", content: m.content });
    } else {
      messages.push({ role: "assistant", content: m.content });
    }
  }
  if (messages.length === 0 || messages[messages.length - 1].content !== userMessage) {
    messages.push({ role: "user", content: userMessage });
  }

  const result = await generateText({
    model: envoyModel(DEFAULT_MODEL_ID),
    system: systemPrompt,
    messages,
    tools,
    maxOutputTokens: 1500,
    stopWhen: ({ steps }) => steps.length >= 5,
  });

  return { text: result.text, toolCalls };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePlaybook(
  module: IntentModule,
  matchResult: MatchResult,
): readonly string[] {
  return typeof module.composerPlaybook === "function"
    ? module.composerPlaybook(matchResult)
    : module.composerPlaybook;
}

// ---------------------------------------------------------------------------
// runModule — the orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a module end-to-end (buffered mode).
 *
 * Sequence:
 *  1. contextLoader → ModuleContextOutput
 *  2. composeSystemPrompt(fragments + context) → system prompt
 *  3. composerInvoker → text + tool calls (THIS IS THE COMPOSER LAYER, Rule 17 layer 3)
 *  4. parseActions → ActionRequest[]
 *  5. preEmitChecks (deterministic; with retry on flag)
 *  6. postStreamGuards (deterministic; same retry budget — max 2 per turn)
 *  7. validate parsedActions ⊆ allowedActions
 *  8. dispatch via executeActions (canonical actions.ts)
 *  9. format output per responseStyle
 *  10. return RunnerOutput with moduleGuard metadata
 */
export async function runModule(input: RunnerInput): Promise<RunnerOutput> {
  if (input.streaming) {
    throw new Error("Streaming mode not implemented in PR1a; ships in PR5b");
  }

  const module = lookupModule(input.surface, input.intent);
  if (!module) {
    throw new Error(`No module registered for ${input.surface}/${input.intent}`);
  }

  const invoker = input.composerInvoker ?? defaultComposerInvoker;

  const moduleGuard: ModuleGuardRecord = {
    bucket: module.moduleGuardBucket,
    guardsFired: [],
    retryCount: 0,
    retrySucceeded: null,
    exhaustedRetries: false,
    toolCalls: [],
  };

  // 1. Load context.
  const contextOutput = await module.contextLoader(
    input.moduleContext,
    input.matchResult,
    input.userMessage,
  );

  // 2. Compose system prompt.
  const fragments = resolvePlaybook(module, input.matchResult);
  const systemPrompt = composeSystemPrompt(fragments, contextOutput, input.moduleContext);

  // 3. Invoke composer (Sonnet LLM call — Rule 17 layer 3).
  const initialResult = await invoker({
    systemPrompt,
    history: input.conversationHistory,
    userMessage: input.userMessage,
    tools: module.composerTools,
    moduleContext: input.moduleContext,
  });

  let text = initialResult.text;
  if (initialResult.toolCalls) {
    for (const c of initialResult.toolCalls) moduleGuard.toolCalls.push(c);
  }

  // 4. Parse actions.
  let parsedActions = parseActions(text);

  // 5 + 6. Pre-emit + post-stream guards with retry.
  // Per M6: max 2 retries per turn; budget shared across pre/post phases.
  type FireRecord = {
    name: string;
    phase: "preEmit" | "postStream";
    flaggedReason: string;
    hint: string;
    severity: "advisory" | "blocking";
    fallbackProse?: string;
  };

  let lastFire: FireRecord | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_TURN; attempt++) {
    let fire: FireRecord | null = null;

    // PreEmit checks (state-aware; deterministic). First fire wins.
    for (const check of module.preEmitChecks ?? []) {
      const result = await check.check({
        parsedActions,
        contextOutput,
        moduleContext: input.moduleContext,
      });
      if (result) {
        fire = {
          name: check.name,
          phase: "preEmit",
          flaggedReason: result.flaggedReason,
          hint: result.hint,
          severity: check.severity,
          fallbackProse: result.fallbackProse,
        };
        break;
      }
    }

    // PostStream guards (prose-coherence; advisory). Only run if preEmit clean.
    if (!fire) {
      const useDefaults = module.useDefaultPostStreamGuards !== false;
      const guards = useDefaults
        ? [...module.postStreamGuards, ...DEFAULT_POST_STREAM_GUARDS]
        : module.postStreamGuards;
      for (const guard of guards) {
        const result = guard.check({
          text,
          parsedActions,
          moduleContext: input.moduleContext,
        });
        if (result) {
          fire = {
            name: guard.name,
            phase: "postStream",
            flaggedReason: result.flaggedReason,
            hint: result.hint,
            severity: "advisory",
          };
          break;
        }
      }
    }

    if (!fire) {
      if (attempt > 0) moduleGuard.retrySucceeded = true;
      lastFire = null;
      break;
    }

    // Guard fired. Record + decide whether to retry or exhaust.
    moduleGuard.guardsFired.push({
      name: fire.name,
      phase: fire.phase,
      flaggedReason: fire.flaggedReason,
    });

    if (attempt >= MAX_RETRIES_PER_TURN) {
      moduleGuard.exhaustedRetries = true;
      moduleGuard.retrySucceeded = false;
      lastFire = fire;
      break;
    }

    // Retry the composer with the hint as the next user turn.
    moduleGuard.retryCount = (attempt + 1) as 0 | 1 | 2;
    const retryHistory: Array<{ role: string; content: string }> = [
      ...input.conversationHistory,
      { role: "user", content: input.userMessage },
      { role: "assistant", content: text },
    ];
    const retryResult = await invoker({
      systemPrompt,
      history: retryHistory,
      userMessage: fire.hint,
      tools: module.composerTools,
      moduleContext: input.moduleContext,
    });
    text = retryResult.text;
    if (retryResult.toolCalls) {
      for (const c of retryResult.toolCalls) moduleGuard.toolCalls.push(c);
    }
    parsedActions = parseActions(text);
  }

  // Per N3: if exhaustion was on a blocking-severity preEmit, ship fallbackProse.
  let blockingExhaustion: { checkName: string; fallbackProse: string } | null = null;
  if (
    moduleGuard.exhaustedRetries &&
    lastFire?.phase === "preEmit" &&
    lastFire.severity === "blocking" &&
    lastFire.fallbackProse
  ) {
    blockingExhaustion = {
      checkName: lastFire.name,
      fallbackProse: lastFire.fallbackProse,
    };
  }

  // 7. Validate parsedActions ⊆ allowedActions. Strip out-of-bounds emissions.
  const allowed = new Set(module.allowedActions);
  const stripped = parsedActions.filter((a) => !allowed.has(a.action));
  if (stripped.length > 0) {
    for (const a of stripped) {
      moduleGuard.guardsFired.push({
        name: "allowed-actions-violation",
        phase: "postStream",
        flaggedReason: `module ${module.intent} emitted disallowed action ${a.action}`,
      });
    }
    parsedActions = parsedActions.filter((a) => allowed.has(a.action));
  }

  // 8. Action dispatch via canonical actions.ts.
  let actionResults: ActionResult[] = [];
  if (parsedActions.length > 0 && !blockingExhaustion) {
    actionResults = await executeActions(parsedActions, input.moduleContext.user.id, {
      sessionId: input.moduleContext.session?.id,
    });
  }

  // 9. Format per responseStyle. Strip action blocks from prose.
  let displayText = stripActionBlocks(text);

  if (blockingExhaustion) {
    // Per N3: replace prose with fallback; clear actions (rule write doesn't happen).
    displayText = blockingExhaustion.fallbackProse;
    moduleGuard.blockingFallbackShipped = {
      checkName: blockingExhaustion.checkName,
      prose: blockingExhaustion.fallbackProse,
    };
    parsedActions = [];
  }

  return {
    kind: "buffered",
    text: displayText,
    parsedActions,
    actionResults,
    moduleGuard,
    systemPrompt,
  };
}
