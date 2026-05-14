/**
 * Unified agent runner — single Sonnet call per host turn with tools.
 *
 * Replaces the two-stage Classifier (Haiku) → Composer (Sonnet) pipeline.
 * See proposals/2026-05-06_unified-agent-collapse-classifier-composer.md
 *
 * **Phase A.1 (2026-05-11):** factored into two layers per the deal-room
 * migration proposal (`2026-05-11_complete-unified-agent-migration-...`):
 *
 *   - `runUnifiedTurn(config)` — the shared streaming loop. Persistence-agnostic;
 *     the caller provides tools, history, system prompt, and a callback that
 *     writes the envoy message to whichever table is appropriate (ChannelMessage
 *     for host-channel, Message for deal-room).
 *   - `runUnifiedAgent(ctx)` — the host-channel entry point. Builds the
 *     host-channel-specific config (channel persistence + history loading +
 *     tool building) and calls `runUnifiedTurn`. Behavior unchanged from
 *     pre-A.1 — this is a pure refactor.
 *
 * Phase A.4 will add deal-room callers (`runDealroomHostTurn`,
 * `runDealroomGuestTurn`) that compose their own `UnifiedTurnConfig` for the
 * Message table + deal-room context.
 *
 * Response format: NDJSON matching the existing channel/chat/route.ts contract:
 *   {"type":"status","stage":"...","copy":"...","seq":N}   — progress frames
 *   {"type":"text","content":"..."}                        — final envoy text
 */

import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { prisma } from "@/lib/prisma";
import { envoyModel } from "@/lib/model";
import { narrateFinalizeError } from "@/agent/action-narration";
import {
  selectModelForTurn,
  computeTurnCost,
  type TurnCost,
} from "./model-policy";
import { buildUnifiedTools, type AgentToolContext } from "./tools";
import type { LoadResultShape } from "./grounding-check";
import type { GroundingFire } from "./tool-impls/_exec";
import { runSelfCheck, type ToolCallSummary } from "./self-check";
import {
  runPostStreamChecks,
  DEFAULT_POST_STREAM_CHECKS,
  type PostStreamCheck,
  type PostStreamGuardRecord,
} from "./post-stream-checks";
import type { Prisma } from "@prisma/client";

import { unifiedAgentSystemPrompt } from "@/agent/runtime-prompts";
import { emojiForActivity } from "@/lib/activity-vocab";

// Loaded once at module init — readFileSync inside, so cached across requests.
const SYSTEM_PROMPT = unifiedAgentSystemPrompt();
const MAX_STEPS = 8; // passed as stopCondition: stepCountIs(MAX_STEPS)

// Captured once per cold start. VERCEL_GIT_COMMIT_SHA is injected at build time;
// falls back to "local" for dev environments without it.
const PROMPT_VERSION = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";

export type UnifiedAgentContext = {
  userId: string;
  channelId: string;
  timezone: string;
  userName: string | null;
  meetSlug?: string;
  message: string;
  isAdmin?: boolean;
};

type EnqueueFn = (chunk: string) => void;

/**
 * History row shape consumed by `runUnifiedTurn`. Matches the AI SDK's
 * `ModelMessage`-compatible subset that we cache-tag before passing to
 * `streamText`. Loaded by the caller (host-channel uses `loadRecentHistory`;
 * deal-room will use its own session-scoped loader in A.4).
 */
export type UnifiedHistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * Persistence callback args. Returned `threadId` lets the caller link the
 * envoy row to a NegotiationSession when a tool returned a sessionId.
 */
export type PersistEnvoyMessageArgs = {
  content: string;
  metadata: Prisma.InputJsonValue;
  threadId?: string;
};

/**
 * Configuration for a single unified-agent turn. The `runUnifiedTurn` function
 * is persistence-agnostic and table-agnostic; everything host-channel-specific
 * or deal-room-specific is provided here.
 *
 * **Phase A.1 scope:** the fields below are exactly what `runUnifiedAgent`
 * needs. Phase A.4 will extend this type with deal-room-specific fields
 * (dual-tz state, negotiated-* GROUND TRUTH, sessionLiveEvent) without
 * breaking host-channel callers.
 */
export type UnifiedTurnConfig = {
  /** The host's user id — used by tool implementations + self-check. */
  userId: string;
  /** The user's message for this turn. Persisted upstream by the caller. */
  userMessage: string;
  /** System prompt loaded by the caller. Host-channel uses `unifiedAgentSystemPrompt()`. */
  systemPrompt: string;
  /** Tool surface for this turn. Built by the caller from request context. */
  tools: ToolSet;
  /** Recent conversation history, sanitized for AI-SDK consumption. */
  recentMessages: UnifiedHistoryMessage[];
  /** Tier-selection signal: did any envoy turn in the window use tools? */
  priorToolUseInHistory: boolean;
  /** Tier-selection signal: count of envoy turns in the window. */
  priorEnvoyTurnCount: number;
  /**
   * Tier-selection signal: age of the most recent envoy turn in ms. Gates the
   * v3 recency-window Haiku tier selection (cost-reduction 2026-05-12 §A):
   * stale prior tool use (8h+) drops to Haiku rather than keeping Sonnet on
   * dead history. `undefined` = no prior envoy turns (cold channel).
   */
  priorEnvoyTurnAgeMs?: number;
  /**
   * Whether the caller's history loader trimmed the recentMessages array to
   * empty because the prior envoy turn was older than its staleness threshold
   * (10 min for host-channel per `STALE_HISTORY_THRESHOLD_MS`; deal-room mirrors
   * the same). Persisted to `metadata.unifiedTurn.historyTrimmedForStaleness`
   * for the 7-day measurement window. Defaults to false.
   */
  historyTrimmedForStaleness?: boolean;
  /** Stream sink for status + text frames. Caller owns the ReadableStream. */
  enqueue: EnqueueFn;
  /**
   * Optional post-stream checks (Phase A.5 + B3-c convergence). When supplied,
   * the runner calls `runPostStreamChecks` after the stream completes and
   * persists fires as `metadata.unifiedTurn.postStreamGuards`. Defaults to
   * the DEFAULT_POST_STREAM_CHECKS array when omitted; deal-room callers
   * (A.4) and host-channel callers both get coverage by default.
   * Pass `[]` to disable (only useful for tests).
   */
  postStreamChecks?: readonly PostStreamCheck[];
  /**
   * Getter for the per-turn grounding-check fires accumulator. The caller
   * (host-channel or deal-room runner entry) sets this when it builds the
   * `recordGroundingFire` callback on `AgentToolContext`. The runner reads
   * the accumulator after the stream finishes and surfaces fires in
   * `metadata.unifiedTurn.groundingCheckFires` (capped at 3 with truncation).
   * 2026-05-12 grounding-check-evidence-scope-redesign PR-D.
   */
  getGroundingFires?: () => readonly GroundingFire[];
  /**
   * Called after the stream finishes and metadata is composed. The caller
   * persists to whichever table is appropriate (ChannelMessage for host-channel,
   * Message for deal-room). Receives the final text, full metadata blob, and
   * an optional threadId derived from a tool result.
   *
   * `steps` and `fullText` are also surfaced so deal-room callers can parse
   * `[DELEGATE_SPEAKER]` blocks off the prose + attach to the upstream guest
   * message's metadata (per handoff §6.3).
   */
  persistEnvoyMessage: (args: PersistEnvoyMessageArgs) => Promise<void>;
};

/**
 * Run a single unified-agent turn against the provided config.
 *
 * Streams text + status frames through `config.enqueue`, runs self-check + a
 * remediation pass on flag, computes cost telemetry, and calls
 * `config.persistEnvoyMessage` with the final text + metadata. Does NOT close
 * the stream — the caller owns the ReadableStream wrapper and closes its
 * controller after this returns (success or after handling thrown errors).
 *
 * On stream error, emits `narrateFinalizeError()` as a final text frame and
 * rethrows so the caller can decide whether to close or surface.
 */
export async function runUnifiedTurn(config: UnifiedTurnConfig): Promise<void> {
  const {
    userId,
    userMessage,
    systemPrompt,
    tools,
    recentMessages,
    priorToolUseInHistory,
    priorEnvoyTurnCount,
    enqueue,
    priorEnvoyTurnAgeMs,
    historyTrimmedForStaleness = false,
    postStreamChecks = DEFAULT_POST_STREAM_CHECKS,
    persistEnvoyMessage,
  } = config;

  try {
    // Emit thinking frame so UI shows activity.
    emitStatus(enqueue, "thinking", 1);

    // Select model tier — Haiku for short single-turn cases on established
    // channels, Sonnet for cold-channel and multi-step turns, Opus for long.
    // priorEnvoyTurnAgeMs gates the recency window: stale prior tool use
    // (8h+) drops to Haiku rather than keeping Sonnet on dead history.
    const modelSelection = selectModelForTurn({
      messageLength: userMessage.length,
      priorToolUseInHistory,
      priorEnvoyTurnCount,
      priorEnvoyTurnAgeMs,
    });

    // Stream the unified agent response.
    //
    // Anthropic prompt caching: mark the system prompt as ephemeral so
    // every turn's static prefix (system + tool definitions) hits the
    // cache. 5-min TTL; cache write on first turn, reads ~10x cheaper.
    //
    // Extended thinking — adaptive mode (Anthropic's recommended config
    // on Sonnet 4.6+; the older fixed `budgetTokens` API is deprecated).
    // Lets the model decide whether and how long to think per turn —
    // policy-heavy turns get more, simple acks get none. Reasoning trace
    // is still captured to metadata.unifiedTurn.reasoningTrace
    // (admin-only diagnostic, not streamed to the client).
    //
    // Tier-aware gate (2026-05-12 cost reduction §B):
    //   - UA_THINKING_DISABLED=true env: kill switch, off everywhere.
    //   - tier === "fast" (Haiku): off — adaptive thinking burns output
    //     tokens on a tier where its value is lowest.
    //   - messageLength <= 80 chars: off — mechanical turns ("block
    //     Wednesdays", "yes go for it") don't benefit from thinking and
    //     pay output-rate tokens for it.
    //   - everything else: adaptive (model decides budget per turn).
    // 2026-05-13 (cmp4rin7c): extended thinking disabled by default. Reasoning
    // leaked into visible content in multiple reports despite explicit prompt
    // rules; adaptive thinking's cost/quality benefit didn't justify the
    // narration-leak risk on host-facing turns. Re-enable with UA_THINKING_ENABLED=true
    // for experiments. The tier + short-turn gates are preserved so that if
    // we flip the env back on, the prior fine-grained policy still applies.
    const SHORT_TURN_NO_THINK_THRESHOLD = 80;
    const thinkingEnabled =
      process.env.UA_THINKING_ENABLED === "true" &&
      modelSelection.tier !== "fast" &&
      userMessage.length > SHORT_TURN_NO_THINK_THRESHOLD;
    const startMs = Date.now();
    // Two cache breakpoints:
    //   1) tools + system prompt (always-stable prefix; written on first turn
    //      of a conversation, read on every subsequent turn within 5-min TTL).
    //   2) the most recent message in history (slides forward each turn).
    //      Anthropic does longest-prefix matching across breakpoints, so the
    //      conversation prefix accumulates cache hits turn-over-turn instead
    //      of replaying uncached. On a 5-turn conversation this drops input
    //      cost ~30-50% beyond the system-only baseline.
    const cachedHistory = withTrailingCacheBreakpoint(recentMessages);
    const result = streamText({
      model: envoyModel(modelSelection.modelId),
      messages: [
        {
          role: "system",
          content: systemPrompt,
          providerOptions: {
            // 1-hour TTL on the static prefix (system prompt + tools — the
            // tools array is cached because it's before this block in the
            // request order). Anthropic's 1h cache write costs 2x input
            // (vs 1.25x for 5m default), but for John's traffic pattern
            // (turns spaced 10-60 min apart), 1h dramatically reduces
            // cold-start cache rewrites. Per-turn cost analysis 2026-05-08
            // showed cache writes were 60-87% of total cost on cold starts.
            anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
          },
        },
        ...cachedHistory,
        { role: "user", content: userMessage },
      ],
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      providerOptions: thinkingEnabled
        ? {
            anthropic: {
              thinking: { type: "adaptive" },
            },
          }
        : undefined,
    });

    // Consume fullStream progressively — emit text tokens as they arrive
    // so the client sees streaming output rather than waiting for the full
    // response. Status frames fire on tool calls so the UI stays active
    // during multi-step turns (LOAD → write).
    //
    // We also accumulate `reasoning-*` chunks (extended thinking) into
    // a separate `reasoningTrace` buffer that gets persisted to metadata.
    // The trace is admin-only diagnostic — never streamed to the client
    // (would leak the model's internal reasoning to the host).
    let fullText = "";
    let reasoningTrace = "";
    let statusSeq = 2;
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        fullText += chunk.text;
        // Emit partial text — client parser keeps the last text frame.
        emitText(enqueue, fullText);
      } else if (chunk.type === "tool-call") {
        // Emit a human-readable status for the tool being called.
        const copy = TOOL_STATUS_COPY[chunk.toolName] ?? "Working on it…";
        emitStatus(enqueue, chunk.toolName, statusSeq++, copy);
      } else if (chunk.type === "reasoning-delta") {
        // Accumulate reasoning into the trace. Not streamed to client.
        const text = (chunk as { text?: string }).text;
        if (typeof text === "string") reasoningTrace += text;
      }
    }

    // Promises resolve once fullStream is exhausted.
    // totalUsage is the SUM across all steps in this turn (LOAD → write → narrate);
    // result.usage would be just the last step's tokens (PR #217 review fix).
    const [steps, usage] = await Promise.all([result.steps, result.totalUsage]);

    const toolCallNames: string[] = steps.flatMap((step) =>
      step.toolCalls.map((tc) => tc.toolName),
    );
    const toolCallSummaries: ToolCallSummary[] = steps.flatMap((step) =>
      step.toolCalls.map((tc) => ({
        toolName: tc.toolName,
        input: tc.input as Record<string, unknown>,
      })),
    );

    // Mirror tool calls + their results into the legacy
    // `actions` / `actionResults` metadata shape so the feedback outcome
    // classifier and bundle builder recognize this turn as having acted.
    // Without this, every unified-runner turn that uses tools (rule_add,
    // personal_link_create, etc.) gets classified `no_action` — see
    // build-filing-context.ts and bundle-builder.ts.
    type ActionResultLike = { success?: boolean; message?: string; data?: Record<string, unknown> };
    const legacyActions: { action: string; params: Record<string, unknown> }[] = [];
    const legacyActionResults: { action: string; success: boolean; message: string; data?: Record<string, unknown> }[] = [];
    for (const step of steps) {
      const results = step.toolResults ?? [];
      step.toolCalls.forEach((tc, i) => {
        const input = (tc.input ?? {}) as Record<string, unknown>;
        legacyActions.push({ action: tc.toolName, params: input });
        const out = results[i]?.output as ActionResultLike | undefined;
        legacyActionResults.push({
          action: tc.toolName,
          success: out?.success === true,
          message: typeof out?.message === "string" ? out.message : "",
          ...(out?.data ? { data: out.data } : {}),
        });
      });
    }

    // Layer 4 — self-check (post-stream, fast model).
    const selfCheckResult = await runSelfCheck(
      toolCallSummaries,
      userMessage,
      recentMessages,
    );

    // Layer 4 retry (2026-05-07): when self-check flags a turn, run a
    // remediation streamText that corrects the issue (the model sees its
    // own prior response + the flag reason and issues update/archive
    // calls as needed). User sees the correction streamed in-place,
    // replacing the original text. The original turn's writes remain in
    // the DB; the model uses corrective tools to fix them.
    let remediationToolNames: string[] = [];
    let remediationCost: TurnCost | null = null;
    let remediationDurationMs: number | null = null;
    let remediated = false;

    if (!selfCheckResult.passed) {
      console.warn(
        "[unified-agent] self-check flagged:",
        selfCheckResult.flaggedTools,
        selfCheckResult.reason,
      );

      const remediationStart = Date.now();
      emitStatus(enqueue, "checking", statusSeq++, "Reviewing and correcting…");

      const remediationResult = streamText({
        model: envoyModel(modelSelection.modelId),
        messages: [
          {
            role: "system",
            content: systemPrompt,
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
            },
          },
          ...withTrailingCacheBreakpoint(recentMessages),
          { role: "user", content: userMessage },
          { role: "assistant", content: fullText },
          {
            role: "user",
            content:
              `[INTERNAL]\n` +
              `Flagged: ${(selfCheckResult.flaggedTools ?? []).join(", ") || "(unspecified)"}\n` +
              `Reason: ${selfCheckResult.reason ?? "(unspecified)"}\n\n` +
              // Tightened 2026-05-12: the prior remediation prompt framed the
              // task as "if on review the prior turn's tool calls were actually
              // correct..." which Haiku narrated literally ("However, looking
              // more carefully..."), producing the reasoning-leak prose
              // (cmp2qcnjy0011s5n70linsdkx). The new instruction is template-
              // only with no "review" framing.
              `Output exactly one confirmation sentence in the system prompt's template style ("Wednesdays blocked.", "Susan's link is updated — 45 min, in-person."). If a correction tool is needed, call it FIRST, silently, then emit the one sentence. If no correction is needed, emit the one sentence describing the final state. Never narrate reasoning. Never say "looking more carefully", "however", "now I'll", "let me", "on review", or any "thinking out loud" phrase. Never expose internal field names (\`guestPicks\`, \`recurrence\`, \`availability\`). Never reference the prior turn. One sentence. Period.`,
          },
        ],
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
      });

      // Stream remediation text — replaces the prior text in the client
      // (which keeps only the latest text frame).
      let remediationText = "";
      for await (const chunk of remediationResult.fullStream) {
        if (chunk.type === "text-delta") {
          remediationText += chunk.text;
          emitText(enqueue, remediationText);
        } else if (chunk.type === "tool-call") {
          const copy = TOOL_STATUS_COPY[chunk.toolName] ?? "Correcting…";
          emitStatus(enqueue, chunk.toolName, statusSeq++, copy);
        }
      }

      const [remedSteps, remedUsage] = await Promise.all([
        remediationResult.steps,
        remediationResult.totalUsage,
      ]);
      remediationToolNames = remedSteps.flatMap((s) =>
        s.toolCalls.map((tc) => tc.toolName),
      );
      remediationDurationMs = Date.now() - remediationStart;
      remediationCost = computeTurnCost(
        remedUsage,
        modelSelection.modelId,
        modelSelection,
      );
      remediated = true;

      // The persisted envoy text is now the remediation, not the original.
      fullText = remediationText;
    }

    const durationMs = Date.now() - startMs;
    // Combine costs across original + remediation.
    const baseCost = computeTurnCost(usage, modelSelection.modelId, modelSelection);
    const turnCost: TurnCost = remediationCost
      ? {
          model: baseCost.model,
          tier: baseCost.tier,
          inputTokens: baseCost.inputTokens + remediationCost.inputTokens,
          outputTokens: baseCost.outputTokens + remediationCost.outputTokens,
          cacheReadTokens: baseCost.cacheReadTokens + remediationCost.cacheReadTokens,
          cacheWriteTokens: baseCost.cacheWriteTokens + remediationCost.cacheWriteTokens,
          costUsd: baseCost.costUsd + remediationCost.costUsd,
        }
      : baseCost;
    // Combined tool-call list — original + remediation.
    const allToolCallNames = remediated
      ? [...toolCallNames, ...remediationToolNames]
      : toolCallNames;

    // Extract sessionId from any tool result that carries one — used to
    // attach this message to the session card in the feed (threadId).
    // Mirrors the same logic in dispatch-stream.ts for the module path.
    // AI SDK uses `.output` (not `.result`) on both static and dynamic results.
    type ActionResult = { success?: boolean; data?: { sessionId?: string } };
    const threadId = steps
      .flatMap((step) => step.toolResults ?? [])
      .map((tr) => tr.output as ActionResult)
      .find((r) => r?.success && typeof r?.data?.sessionId === "string")
      ?.data?.sessionId;

    // Extract link card metadata for all three link-create tool types so
    // feed.tsx renders a structured card instead of a bare URL blob.
    const linkCardExtras = extractLinkCardMeta(steps);

    // Phase A.5 — post-stream checks (cmp1nni72 narration-without-emit +
    // cost-reduction success-theater, converged into one module per B3-c).
    // SEV-WARN log-only in v1; fires get persisted to
    // `metadata.unifiedTurn.postStreamGuards` so we can measure rates before
    // deciding whether to escalate to text-replacement or remediation rerun.
    const postStreamToolCalls = legacyActionResults.map((r) => ({
      toolName: r.action,
      success: r.success,
    }));
    const { guards: postStreamGuards, replacedFullText } = runPostStreamChecks(
      { fullText, toolCalls: postStreamToolCalls },
      postStreamChecks,
    );
    // A check may have requested replacing `fullText` (e.g., narration-leak
    // truncation strips reasoning preambles from the visible message). Apply
    // before persistence and the final emit so the client sees the clean text.
    if (replacedFullText !== null) {
      fullText = replacedFullText;
    }

    // Compose the metadata blob and hand it to the caller's persistence
    // callback. Host-channel writes to `ChannelMessage`; deal-room (A.4)
    // writes to `Message`. Same blob shape; different table.
    const metadata = {
      ...(buildUnifiedMetadata({
        turnCost,
        toolCallNames: allToolCallNames,
        modelId: modelSelection.modelId,
        modelSelectionReason: modelSelection.reason,
        thinkingEnabled,
        historyTrimmedForStaleness,
        durationMs,
        selfCheck: selfCheckResult,
        remediated,
        remediationDurationMs,
        reasoningTrace: reasoningTrace.trim() ? reasoningTrace : null,
        postStreamGuards,
        groundingCheckFires: config.getGroundingFires?.() ?? [],
      }) as object),
      ...(legacyActions.length > 0
        ? { actions: legacyActions, actionResults: legacyActionResults }
        : {}),
      ...(linkCardExtras
        ? {
            linkKind: linkCardExtras.linkKind,
            ...(linkCardExtras.linkUrl ? { linkUrl: linkCardExtras.linkUrl } : {}),
            ...(linkCardExtras.linkCardMeta ? { linkCardMeta: linkCardExtras.linkCardMeta } : {}),
            // Keep legacy bookableMeta key populated for bookable links
            // so rows written before linkCardMeta existed still render.
            ...(linkCardExtras.linkKind === "bookable" && linkCardExtras.linkCardMeta
              ? { bookableMeta: linkCardExtras.linkCardMeta }
              : {}),
          }
        : {}),
    } as Prisma.InputJsonValue;

    await persistEnvoyMessage({
      content: fullText,
      metadata,
      ...(threadId ? { threadId } : {}),
    });

    // Final text frame — ensures the client has the complete content even
    // if a partial frame was the last one emitted during streaming.
    emitText(enqueue, fullText);

    // `userId` is reserved for future tool implementations that need it
    // (Phase A.4 deal-room runners thread it through `triggeringRole` plumbing).
    // Referenced here to satisfy lint until then.
    void userId;
  } catch (err) {
    console.error("[unified-agent] stream error:", err);
    try {
      emitText(enqueue, narrateFinalizeError());
    } catch {
      /* enqueue may already be closed */
    }
    throw err;
  }
}

/**
 * Host-channel entry point. Returns a ReadableStream<Uint8Array> matching the
 * existing NDJSON protocol so route.ts can return it directly.
 *
 * Builds the host-channel-specific config (channel-scoped persistence,
 * `loadRecentHistory`, host-channel tool set, host-channel system prompt) and
 * delegates the streaming loop to `runUnifiedTurn`.
 */
export function runUnifiedAgent(ctx: UnifiedAgentContext): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue: EnqueueFn = (chunk) => {
        controller.enqueue(encoder.encode(chunk));
      };

      try {
        // Persist user message immediately. Host-channel-specific —
        // deal-room callers persist to the `Message` table at their route.
        await prisma.channelMessage.create({
          data: { channelId: ctx.channelId, role: "user", content: ctx.message },
        });

        // Load recent conversation history (host-channel-scoped). Loaded
        // BEFORE buildUnifiedTools so the per-turn grounding-check
        // `recentThread` window is available to the tool context. The
        // `priorEnvoyTurnAgeMs` field gates the v3 recency-window Haiku tier
        // selection (cost-reduction proposal 2026-05-12 §A). Threaded through
        // UnifiedTurnConfig so deal-room callers (A.4) also benefit.
        const {
          messages: recentMessages,
          priorToolUseInHistory,
          priorEnvoyTurnCount,
          priorEnvoyTurnAgeMs,
          historyTrimmedForStaleness,
        } = await loadRecentHistory(ctx.channelId);

        // ── Per-turn accumulators for grounding-check value-match + telemetry ──
        // 2026-05-12 grounding-check-evidence-scope-redesign (PR-B):
        // - thisTurnToolResults: LOAD tool results pushed as they arrive;
        //   read by the grounding check's value-match logic to verify that
        //   IDs / values the model emits actually came from a LOAD.
        // - groundingFires: structured fire records accumulated across the
        //   turn; consumed by PR-D's metadata builder.
        const thisTurnToolResults: LoadResultShape[] = [];
        const groundingFires: GroundingFire[] = [];

        // recentThread: extract prior user + envoy turn from the 2-turn preload.
        // When historyTrimmedForStaleness fired, recentMessages is empty →
        // recentThread is undefined → recentThread-scoped grounding-check
        // fields fall back to the distinctive "stale context" error message.
        const recentThread: AgentToolContext["recentThread"] =
          historyTrimmedForStaleness || recentMessages.length === 0
            ? undefined
            : {
                priorUserTurn: recentMessages.find((m) => m.role === "user")?.content,
                priorEnvoyTurn: recentMessages.find((m) => m.role === "assistant")?.content,
              };

        // Build tool surface for this request (with userMessage for Layer 2 grounding).
        const tools = buildUnifiedTools({
          userId: ctx.userId,
          timezone: ctx.timezone,
          meetSlug: ctx.meetSlug,
          userMessage: ctx.message,
          channelId: ctx.channelId,
          recentThread,
          getThisTurnToolResults: () => thisTurnToolResults,
          recordToolResult: (toolName, result) => {
            thisTurnToolResults.push({ toolName, result } as LoadResultShape);
          },
          recordGroundingFire: (fire) => {
            groundingFires.push(fire);
          },
        });

        await runUnifiedTurn({
          userId: ctx.userId,
          userMessage: ctx.message,
          systemPrompt: SYSTEM_PROMPT,
          tools,
          recentMessages,
          priorToolUseInHistory,
          priorEnvoyTurnCount,
          priorEnvoyTurnAgeMs,
          historyTrimmedForStaleness,
          getGroundingFires: () => groundingFires,
          enqueue,
          persistEnvoyMessage: async ({ content, metadata, threadId }) => {
            await prisma.channelMessage.create({
              data: {
                channelId: ctx.channelId,
                role: "envoy",
                content,
                ...(threadId ? { threadId } : {}),
                metadata,
              },
            });
          },
        });

        controller.close();
      } catch (err) {
        // `runUnifiedTurn` already emitted `narrateFinalizeError` before
        // rethrowing. Just close the stream cleanly.
        try {
          controller.close();
        } catch {
          try { controller.error(err); } catch { /* already closed */ }
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitStatus(enqueue: EnqueueFn, stage: string, seq: number, copy = "Working on it…"): void {
  const frame = { type: "status", stage, copy, seq };
  enqueue(JSON.stringify(frame) + "\n");
}

const TOOL_STATUS_COPY: Record<string, string> = {
  // LOAD
  LOAD_calendar_context:    "Reading your calendar…",
  LOAD_active_sessions:     "Loading your sessions…",
  LOAD_preferences:         "Loading your preferences…",
  // Personal links
  personal_link_create:       "Creating personal link…",
  personal_link_update:       "Updating personal link…",
  personal_link_set_archived: "Updating archive state…",
  // Bookable links
  bookable_link_create:       "Creating bookable link…",
  bookable_link_update:       "Updating bookable link…",
  bookable_link_set_archived: "Updating archive state…",
  // Group events
  group_event_create:         "Setting up group event…",
  group_event_update:         "Updating group event…",
  group_event_set_archived:   "Updating archive state…",
  // Primary link
  primary_link_update:        "Updating primary link…",
  // Sessions
  session_set_archived:       "Updating archive state…",
  session_update_time:        "Updating session…",
  session_hold_slot:          "Holding slot…",
  session_archive_bulk:       "Archiving sessions…",
  // Rules
  rule_add:                 "Adding rule…",
  rule_update:              "Updating rule…",
  rule_remove:              "Removing rule…",
  // Preferences
  prefs_update_appearance:  "Saving appearance…",
  prefs_update_business_hours: "Saving work hours…",
  prefs_update_timezone:    "Saving timezone…",
  knowledge_write:          "Saving note…",
};

function emitText(enqueue: EnqueueFn, content: string): void {
  enqueue(JSON.stringify({ type: "text", content }) + "\n");
}

/**
 * Mark the LAST message in a history array with an Anthropic ephemeral cache
 * breakpoint. Anthropic does longest-prefix matching across breakpoints, so this
 * lets the conversation prefix (tools + system + everything-up-to-here) accumulate
 * cache hits turn-over-turn within the 5-min TTL.
 *
 * No-op on empty arrays.
 */
function withTrailingCacheBreakpoint(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): ModelMessage[] {
  if (messages.length === 0) return messages as ModelMessage[];
  const lastIdx = messages.length - 1;
  const cacheOpts = { anthropic: { cacheControl: { type: "ephemeral" as const } } };
  return messages.map((m, i): ModelMessage =>
    i === lastIdx
      ? m.role === "user"
        ? { role: "user", content: m.content, providerOptions: cacheOpts }
        : { role: "assistant", content: m.content, providerOptions: cacheOpts }
      : m,
  );
}

/**
 * If the most recent prior envoy turn is older than this, history is treated
 * as stale and dropped from the loaded prompt context entirely. The model
 * sees only the current user turn. Closes the F14 cross-thread bleed family
 * (cmp2qcnjy0011s5n70linsdkx, 2026-05-12 — "Christine coffee" turn
 * confused with a Susan link from the prior day's history).
 *
 * John's prescription (2026-05-12): *"if a thread is not recent (prior 10
 * mins) ignore anything ahead of it."* 10 min is tighter than the 15-min
 * `HAIKU_RECENCY_WINDOW_MS` in model-policy.ts — by design. Tier routing
 * tolerates a 15-min in-flight grace period; prompt context tolerates only 10.
 */
const STALE_HISTORY_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Progressive context loading (2026-05-12, John's directive):
 * Even when history is fresh (<STALE_HISTORY_THRESHOLD_MS), we preload only
 * the most recent envoy turn + its immediately preceding user turn — NOT all
 * 10 rows. This handles the "yes go for it" / "change it to 30 min" / bare
 * confirmation shape (which needs to know what `it` is) without exposing the
 * full history to cross-thread scramble.
 *
 * When the model encounters a reference it can't resolve from the preloaded
 * pair (e.g., "the one from earlier today", "the Wednesday rule"), it calls
 * `LOAD_recent_history(count?, sinceMinutesAgo?)` to fetch more. Consistent
 * with the rest of the LOAD_* tool family — calendar, sessions, preferences
 * are all on-demand; history now joins them.
 */
const FRESH_HISTORY_PRELOAD_TURNS = 2; // last user + last envoy

async function loadRecentHistory(
  channelId: string,
): Promise<{
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  priorToolUseInHistory: boolean;
  priorEnvoyTurnCount: number;
  /** Wall-clock ms since the most recent envoy turn was persisted. Undefined
   *  when there are no prior envoy turns. Feeds the recency-window gate in
   *  selectModelForTurn so 8h+ stale "prior tool use" doesn't trap dead
   *  history on Sonnet. */
  priorEnvoyTurnAgeMs?: number;
  /** Whether history was trimmed to empty because the prior envoy turn was
   *  >STALE_HISTORY_THRESHOLD_MS old. Persisted to metadata for the 7-day
   *  measurement window. */
  historyTrimmedForStaleness: boolean;
}> {
  // Take 10 for the signal computation (priorToolUseInHistory looks across
  // the recent window) but PRELOAD only FRESH_HISTORY_PRELOAD_TURNS into the
  // prompt context. Progressive-context architecture per John's 2026-05-12
  // directive — everything beyond the 2-turn preload is loaded on demand via
  // LOAD_recent_history.
  const rows = await prisma.channelMessage.findMany({
    where: { channelId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { role: true, content: true, metadata: true, createdAt: true },
  });
  // Detect whether any envoy turn in the window made a tool call. Used by the
  // tier-selection heuristic to keep Sonnet engaged for multi-step flows.
  const priorToolUseInHistoryRaw = rows.some((r) => {
    if (r.role !== "envoy") return false;
    const md = r.metadata as { unifiedTurn?: { toolCalls?: string[] } } | null;
    return Array.isArray(md?.unifiedTurn?.toolCalls) && md.unifiedTurn.toolCalls.length > 0;
  });
  // Count envoy turns to recognize cold channels. New users with no history
  // ought to stay on Sonnet for create-link requests even when short.
  const priorEnvoyTurnCount = rows.filter((r) => r.role === "envoy").length;
  // Compute age of the most recent envoy turn (rows queried desc → first envoy
  // row in the original ordering wins). Used by the recency-window gate to
  // distinguish in-flight multi-step from stale history.
  const mostRecentEnvoy = rows.find((r) => r.role === "envoy");
  const priorEnvoyTurnAgeMs = mostRecentEnvoy
    ? Date.now() - mostRecentEnvoy.createdAt.getTime()
    : undefined;

  // Stale-history trim. When the prior envoy turn is older than the
  // threshold, drop history entirely — the model sees only the current user
  // turn. Closes the F14 cross-thread bleed family.
  //
  // priorToolUseInHistory is also forced to false in the trimmed case
  // because the model isn't actually seeing those tool calls — keeping
  // it true would lie to the tier router (which would keep Sonnet for an
  // already-fresh channel).
  const historyTrimmedForStaleness =
    typeof priorEnvoyTurnAgeMs === "number" &&
    priorEnvoyTurnAgeMs > STALE_HISTORY_THRESHOLD_MS;

  // Progressive preload: when fresh, keep only the last
  // FRESH_HISTORY_PRELOAD_TURNS (preceding user + envoy turn — handles "yes",
  // "change it", bare confirmations). When stale, drop entirely.
  const messages = historyTrimmedForStaleness
    ? []
    : rows
        .slice(0, FRESH_HISTORY_PRELOAD_TURNS) // rows are desc — take newest N
        .reverse()
        .map((r) => ({
          role: r.role === "envoy" ? ("assistant" as const) : ("user" as const),
          content: r.content,
        }));
  const priorToolUseInHistory = historyTrimmedForStaleness
    ? false
    : priorToolUseInHistoryRaw;

  return {
    messages,
    priorToolUseInHistory,
    priorEnvoyTurnCount,
    priorEnvoyTurnAgeMs,
    historyTrimmedForStaleness,
  };
}

function buildUnifiedMetadata(params: {
  turnCost: TurnCost;
  toolCallNames: string[];
  modelId: string;
  /** `selectModelForTurn().reason` — persisted so production telemetry can
   *  attribute Sonnet/Haiku routing to the actual gate that fired
   *  ("short-no-multistep" / "short-stale-history" / "default" / etc). */
  modelSelectionReason: string;
  /** Whether Anthropic extended-thinking was enabled for this turn. Combined
   *  with `cost.outputTokens` lets us measure the post-2026-05-12 thinking
   *  gate's actual cost impact. */
  thinkingEnabled: boolean;
  /** Whether the loader trimmed history to empty because the prior envoy turn
   *  was older than the staleness threshold. Persisted to telemetry so the
   *  7-day measurement window can attribute regression-free turns to the trim
   *  firing (and false-positive trims to a too-tight threshold). */
  historyTrimmedForStaleness: boolean;
  durationMs: number;
  selfCheck: { passed: boolean; flaggedTools?: string[]; reason?: string };
  /** Layer 4 retry: did this turn run a remediation pass after self-check failed? */
  remediated?: boolean;
  /** Wall-clock duration of the remediation streamText call (ms). Null if not remediated. */
  remediationDurationMs?: number | null;
  /** Anthropic extended-thinking trace if enabled. Admin-only diagnostic — never
   *  surfaced to the host. Null when the feature is disabled or no trace was
   *  emitted. Capped at ~8KB to keep metadata payloads reasonable. */
  reasoningTrace?: string | null;
  /** Post-stream check fires (Phase A.5 + B3-c convergence). Each entry is one
   *  guard that fired this turn (name + scope + reason). Empty array = clean
   *  turn; not persisted when empty to keep metadata payloads small. */
  postStreamGuards?: readonly PostStreamGuardRecord[];
  /** Grounding-check (Layer 2) fires for this turn. Sibling to postStreamGuards.
   *  Capped at first 3 fires with `_truncatedCount` indicating how many extras
   *  fired (P4 mitigation — prevents metadata-bloat from chatty failure modes).
   *  2026-05-12 grounding-check-evidence-scope-redesign PR-D. */
  groundingCheckFires?: readonly GroundingFire[];
}): Prisma.InputJsonValue {
  const {
    turnCost,
    toolCallNames,
    modelId,
    modelSelectionReason,
    thinkingEnabled,
    historyTrimmedForStaleness,
    durationMs,
    selfCheck,
    remediated,
    remediationDurationMs,
    reasoningTrace,
    postStreamGuards,
    groundingCheckFires,
  } = params;

  // Cap groundingCheckFires at first 3 with truncation count.
  // P4 mitigation: chatty failure modes can produce many fires; cap prevents
  // unbounded metadata growth across the 7-day measurement window.
  const GROUNDING_FIRES_PER_TURN_CAP = 3;
  const cappedGroundingFires =
    groundingCheckFires && groundingCheckFires.length > 0
      ? {
          fires: groundingCheckFires.slice(0, GROUNDING_FIRES_PER_TURN_CAP),
          ...(groundingCheckFires.length > GROUNDING_FIRES_PER_TURN_CAP
            ? { _truncatedCount: groundingCheckFires.length - GROUNDING_FIRES_PER_TURN_CAP }
            : {}),
        }
      : null;

  // Synthesize moduleGuard.bucket from tool names for corpus continuity.
  // Maps tool name prefixes to logical bucket names understood by the dashboard.
  const bucket = inferBucket(toolCallNames);

  // Cap reasoning trace size — long traces can balloon JSON payload.
  const trimmedReasoning =
    reasoningTrace && reasoningTrace.length > 8192
      ? reasoningTrace.slice(0, 8192) + "…[truncated]"
      : reasoningTrace ?? null;

  return {
    unifiedTurn: {
      model: modelId,
      tier: turnCost.tier,
      tierReason: modelSelectionReason,
      thinkingEnabled,
      historyTrimmedForStaleness,
      promptVersion: PROMPT_VERSION,
      toolCalls: toolCallNames,
      durationMs,
      selfCheck,
      ...(remediated ? { remediated: true, remediationDurationMs } : {}),
      ...(trimmedReasoning ? { reasoningTrace: trimmedReasoning } : {}),
      ...(postStreamGuards && postStreamGuards.length > 0
        ? { postStreamGuards: [...postStreamGuards] }
        : {}),
      ...(cappedGroundingFires
        ? { groundingCheckFires: cappedGroundingFires as unknown as Prisma.InputJsonValue }
        : {}),
      cost: {
        inputTokens: turnCost.inputTokens,
        outputTokens: turnCost.outputTokens,
        cacheReadTokens: turnCost.cacheReadTokens,
        cacheWriteTokens: turnCost.cacheWriteTokens,
        costUsd: turnCost.costUsd,
      },
    },
    // Corpus-compatible bucket so dashboard + feedback pipeline work unchanged.
    moduleGuard: {
      bucket,
      emittedActions: toolCallNames,
    },
  } satisfies Prisma.InputJsonValue;
}

type LinkCardExtras = {
  linkKind: "bookable" | "personal" | "group";
  linkUrl?: string;
  linkCardMeta?: Record<string, unknown>;
};

/**
 * Scans completed steps for link-create tool calls and extracts the metadata
 * the feed needs to render a structured card. Returns null if no link-create
 * tool fired on this turn.
 */
/**
 * Narrow a free-form tool-input format string to the activity-vocab's typed
 * format union, or `null` when it's not one of the recognized values. The
 * model may emit any string in `params.format`; emojiForActivity's optional
 * format param requires the typed union for the lookup table.
 * 2026-05-14 cmp4u* (call/video emoji fix).
 */
function normalizeFormat(
  format: string | undefined,
): "in-person" | "video" | "phone" | null {
  if (format === "in-person" || format === "video" || format === "phone") {
    return format;
  }
  return null;
}

function extractLinkCardMeta(
  steps: Array<{
    toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>;
    toolResults?: ReadonlyArray<{ output: unknown }>;
  }>,
): LinkCardExtras | null {
  for (const step of steps) {
    const results = step.toolResults ?? [];
    for (let i = 0; i < step.toolCalls.length; i++) {
      const tc = step.toolCalls[i];
      const out = results[i]?.output as
        | { success?: boolean; data?: { url?: string; linkUrl?: string; code?: string; name?: string; activity?: string; activityIcon?: string; format?: string; durationMinutes?: number; daysOfWeek?: number[]; timeStart?: string; timeEnd?: string; recurrence?: unknown; inviteeName?: string; inviteeEmail?: string } }
        | undefined;
      if (!out?.success) continue;
      const data = out.data ?? {};
      const linkUrl = data.url ?? data.linkUrl;

      if (tc.toolName === "bookable_link_create") {
        const input = tc.input as { name?: string; format?: string; durationMinutes?: number; daysOfWeek?: number[]; timeStart?: string; timeEnd?: string; recurrence?: unknown; activity?: string; activityIcon?: string };
        return {
          linkKind: "bookable",
          ...(linkUrl ? { linkUrl } : {}),
          linkCardMeta: {
            name: input.name,
            format: input.format,
            durationMinutes: input.durationMinutes,
            daysOfWeek: input.daysOfWeek,
            timeStart: input.timeStart,
            timeEnd: input.timeEnd,
            recurrence: input.recurrence,
            activity: input.activity,
            activityIcon: input.activityIcon ?? emojiForActivity(input.activity, normalizeFormat(input.format)),
          },
        };
      }
      if (tc.toolName === "personal_link_create") {
        const input = tc.input as { inviteeName?: string; inviteeEmail?: string; activity?: string; activityIcon?: string; format?: string; durationMinutes?: number; recurrence?: unknown };
        return {
          linkKind: "personal",
          ...(linkUrl ? { linkUrl } : {}),
          linkCardMeta: {
            inviteeName: input.inviteeName,
            inviteeEmail: input.inviteeEmail,
            activity: input.activity,
            activityIcon: input.activityIcon ?? emojiForActivity(input.activity, normalizeFormat(input.format)),
            format: input.format,
            durationMinutes: input.durationMinutes,
            recurrence: input.recurrence,
          },
        };
      }
      if (tc.toolName === "group_event_create") {
        const input = tc.input as { topic?: string; inviteeNames?: string[]; activity?: string; activityIcon?: string; format?: string; durationMinutes?: number };
        return {
          linkKind: "group",
          ...(linkUrl ? { linkUrl } : {}),
          linkCardMeta: {
            topic: input.topic,
            inviteeNames: input.inviteeNames,
            activity: input.activity,
            activityIcon: input.activityIcon ?? emojiForActivity(input.activity, normalizeFormat(input.format)),
            format: input.format,
            durationMinutes: input.durationMinutes,
          },
        };
      }
    }
  }
  return null;
}

/**
 * Map tool names → corpus-compatible bucket. Used for the dashboard's
 * `moduleGuard.bucket` continuity with the legacy classifier-composer.
 */
function inferBucket(toolNames: string[]): string {
  if (toolNames.length === 0) return "chat";
  // Prefer the first write tool's bucket — LOAD_* tools are setup, not the
  // "what did this turn do" signal.
  const writeNames = toolNames.filter((n) => !n.startsWith("LOAD_"));
  const first = writeNames[0] ?? toolNames[0];
  if (first.startsWith("rule_")) return "rule";
  if (first.startsWith("bookable_link_")) return "bookable_link";
  if (first.startsWith("personal_link_")) return "personal_link";
  if (first.startsWith("group_event_")) return "group_coordination";
  if (first.startsWith("session_")) return "session";
  if (first.startsWith("primary_link_")) return "primary_link";
  if (first.startsWith("prefs_") || first === "knowledge_write") return "profile";
  return "chat";
}
