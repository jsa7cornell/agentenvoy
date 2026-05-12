/**
 * Unified agent runner — single Sonnet call per host turn with tools.
 *
 * Replaces the two-stage Classifier (Haiku) → Composer (Sonnet) pipeline.
 * See proposals/2026-05-06_unified-agent-collapse-classifier-composer.md
 *
 * Response format: NDJSON matching the existing channel/chat/route.ts contract:
 *   {"type":"status","stage":"...","copy":"...","seq":N}   — progress frames
 *   {"type":"text","content":"..."}                        — final envoy text
 */

import { streamText, stepCountIs, type ModelMessage } from "ai";
import { prisma } from "@/lib/prisma";
import { envoyModel } from "@/lib/model";
import { narrateFinalizeError } from "@/agent/action-narration";
import {
  selectModelForTurn,
  computeTurnCost,
  type TurnCost,
} from "./model-policy";
import { buildUnifiedTools } from "./tools";
import { runSelfCheck, type ToolCallSummary } from "./self-check";
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
 * Main entry point. Returns a ReadableStream<Uint8Array> matching the
 * existing NDJSON protocol so route.ts can return it directly.
 */
export function runUnifiedAgent(ctx: UnifiedAgentContext): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue: EnqueueFn = (chunk) => {
        controller.enqueue(encoder.encode(chunk));
      };

      try {
        // Persist user message immediately.
        await prisma.channelMessage.create({
          data: { channelId: ctx.channelId, role: "user", content: ctx.message },
        });

        // Emit thinking frame so UI shows activity.
        emitStatus(enqueue, "thinking", 1);

        // Build tool surface for this request (with userMessage for Layer 2 grounding).
        const tools = buildUnifiedTools({
          userId: ctx.userId,
          timezone: ctx.timezone,
          meetSlug: ctx.meetSlug,
          userMessage: ctx.message,
        });

        // Load recent conversation history (now also returns tier signals).
        const {
          messages: recentMessages,
          priorToolUseInHistory,
          priorEnvoyTurnCount,
          priorEnvoyTurnAgeMs,
        } = await loadRecentHistory(ctx.channelId);

        // Select model tier — Haiku for short single-turn cases on established
        // channels, Sonnet for cold-channel and multi-step turns, Opus for long.
        // priorEnvoyTurnAgeMs gates the recency window: stale prior tool use
        // (8h+) drops to Haiku rather than keeping Sonnet on dead history.
        const modelSelection = selectModelForTurn({
          messageLength: ctx.message.length,
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
        // Tier-aware gate (2026-05-12 cost reduction):
        //   - UA_THINKING_DISABLED=true env: kill switch, off everywhere.
        //   - tier === "fast" (Haiku): off — adaptive thinking burns output
        //     tokens on a tier where its value is lowest.
        //   - messageLength <= 80 chars: off — mechanical turns ("block
        //     Wednesdays", "yes go for it") don't benefit from thinking and
        //     pay output-rate tokens for it.
        //   - everything else: adaptive (model decides budget per turn).
        const SHORT_TURN_NO_THINK_THRESHOLD = 80;
        const thinkingEnabled =
          process.env.UA_THINKING_DISABLED !== "true" &&
          modelSelection.tier !== "fast" &&
          ctx.message.length > SHORT_TURN_NO_THINK_THRESHOLD;
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
              content: SYSTEM_PROMPT,
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
            { role: "user", content: ctx.message },
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
        // classifier (build-filing-context.ts) and bundle builder
        // (bundle-builder.ts) recognize this turn as having acted. Without
        // this, every unified-runner turn that uses tools gets classified
        // as `lastAgentOutcome: "no_action"` — and feedback triage breaks.
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
          ctx.message,
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
                content: SYSTEM_PROMPT,
                providerOptions: {
                  anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
                },
              },
              ...withTrailingCacheBreakpoint(recentMessages),
              { role: "user", content: ctx.message },
              { role: "assistant", content: fullText },
              {
                role: "user",
                content:
                  `[INTERNAL — self-check flagged your prior turn]\n` +
                  `Flagged: ${(selfCheckResult.flaggedTools ?? []).join(", ") || "(unspecified)"}\n` +
                  `Reason: ${selfCheckResult.reason ?? "(unspecified)"}\n\n` +
                  `Call the correction tool first, then emit one short sentence describing the final correct state. ` +
                  `Match the confirmation-template style from the system prompt (e.g. "Coaching Sessions is daily now, every day 2–5pm."). ` +
                  `Do not add preamble. Do not add apology. Do not reference the prior turn.\n\n` +
                  `If on review the prior turn's tool calls were actually correct (the self-check flag was a false positive), do NOT call any correction tool. Output a single sentence in the system prompt's confirmation-template style describing what was done. Do not say "no correction tool available". Do not expose internal field names like \`guestPicks\`, \`recurrence\`, or \`availability\`. Do not explain why the original was correct — just confirm the action.`,
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

        // Persist envoy message with unified turn metadata.
        await prisma.channelMessage.create({
          data: {
            channelId: ctx.channelId,
            role: "envoy",
            content: fullText,
            ...(threadId ? { threadId } : {}),
            metadata: {
              ...(buildUnifiedMetadata({
                turnCost,
                toolCallNames: allToolCallNames,
                modelId: modelSelection.modelId,
                modelSelectionReason: modelSelection.reason,
                thinkingEnabled,
                durationMs,
                selfCheck: selfCheckResult,
                remediated,
                remediationDurationMs,
                reasoningTrace: reasoningTrace.trim() ? reasoningTrace : null,
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
            } as Prisma.InputJsonValue,
          },
        });

        // Final text frame — ensures the client has the complete content even
        // if a partial frame was the last one emitted during streaming.
        emitText(enqueue, fullText);
        controller.close();

      } catch (err) {
        console.error("[unified-agent] stream error:", err);
        try {
          emitText(enqueue, narrateFinalizeError());
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
}> {
  // Window cut from 20 → 10 (cost-reduction PR 2026-05-07). 10 turns covers
  // the typical multi-turn conversation; longer-tail context is rarely
  // load-bearing and the savings are ~1,500 tokens per turn.
  const rows = await prisma.channelMessage.findMany({
    where: { channelId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { role: true, content: true, metadata: true, createdAt: true },
  });
  // Reverse so oldest-first, map envoy → assistant for AI SDK.
  const messages = rows
    .reverse()
    .map((r) => ({
      role: r.role === "envoy" ? ("assistant" as const) : ("user" as const),
      content: r.content,
    }));
  // Detect whether any envoy turn in the window made a tool call. Used by the
  // tier-selection heuristic to keep Sonnet engaged for multi-step flows.
  const priorToolUseInHistory = rows.some((r) => {
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
  return {
    messages,
    priorToolUseInHistory,
    priorEnvoyTurnCount,
    priorEnvoyTurnAgeMs,
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
}): Prisma.InputJsonValue {
  const {
    turnCost,
    toolCallNames,
    modelId,
    modelSelectionReason,
    thinkingEnabled,
    durationMs,
    selfCheck,
    remediated,
    remediationDurationMs,
    reasoningTrace,
  } = params;

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
      promptVersion: PROMPT_VERSION,
      toolCalls: toolCallNames,
      durationMs,
      selfCheck,
      ...(remediated ? { remediated: true, remediationDurationMs } : {}),
      ...(trimmedReasoning ? { reasoningTrace: trimmedReasoning } : {}),
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
 * needed to render a link card in the chat feed. Mirrors the legacy
 * dispatch-stream.ts bookableMeta stamp logic, extended for personal and group.
 */
function extractLinkCardMeta(
  steps: Array<{
    toolCalls: Array<{ toolName: string; input: unknown }>;
    toolResults?: Array<{ output: unknown }> | null;
  }>,
): LinkCardExtras | null {
  for (const step of steps) {
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      const tr = results[i];
      const out = tr?.output as Record<string, unknown> | undefined;
      if (!out?.success) continue;
      const data = out.data as Record<string, unknown> | undefined;

      // Helper: pick the best-available emoji for a link.
      // Priority: 1) explicit activityIcon arg the model passed (canonical, takes
      //   precedence), 2) emoji derived from an activity arg, 3) emoji derived
      //   from the activity prefix in the handler-generated title (legacy fallback).
      const resolveActivityIcon = (
        args: Record<string, unknown> | undefined,
        title: string | undefined,
      ): string | undefined => {
        const argIcon = typeof args?.activityIcon === "string" && args.activityIcon.trim()
          ? args.activityIcon.trim()
          : null;
        if (argIcon) return argIcon;
        const argActivity = typeof args?.activity === "string" ? args.activity : null;
        const fromActivityArg = argActivity ? emojiForActivity(argActivity) : null;
        if (fromActivityArg) return fromActivityArg;
        const titlePrefix = title?.split(":")[0]?.trim() ?? null;
        return emojiForActivity(titlePrefix) ?? undefined;
      };

      if (tc.toolName === "bookable_link_create") {
        const args = tc.input as Record<string, unknown> | undefined;
        const meta: Record<string, unknown> = {};
        if (data?.bookableName) meta.title = data.bookableName;
        if (data?.linkUrl) meta.linkUrl = data.linkUrl;
        if (data?.daysOfWeek) meta.daysOfWeek = data.daysOfWeek;
        if (data?.timeStart) meta.timeStart = data.timeStart;
        if (data?.timeEnd) meta.timeEnd = data.timeEnd;
        if (data?.durationMinutes) meta.durationMinutes = data.durationMinutes;
        if (data?.format) meta.format = data.format;
        // activityIcon resolution priority:
        //   1. data.activityIcon (handler-persisted, source of truth)
        //   2. args.activityIcon (model passed, may not have persisted if rejected)
        //   3. derived from activity arg or title prefix
        const dataIcon = typeof data?.activityIcon === "string" && data.activityIcon.trim()
          ? (data.activityIcon as string).trim()
          : null;
        const icon = dataIcon
          ?? resolveActivityIcon(args, (data?.bookableName as string) ?? undefined);
        if (icon) meta.activityIcon = icon;
        // Surface recurrence so a recurring bookable link renders the 🔁 affordance.
        if (args?.recurrence) meta.recurrence = args.recurrence;
        if (args?.guestPicks) meta.guestPicks = args.guestPicks;
        return {
          linkKind: "bookable",
          linkUrl: data?.linkUrl as string | undefined,
          linkCardMeta: meta,
        };
      }

      if (tc.toolName === "personal_link_create") {
        const url = data?.url as string | undefined;
        const title = data?.title as string | undefined;
        const args = tc.input as Record<string, unknown> | undefined;
        const meta: Record<string, unknown> = {};
        if (title) meta.title = title;
        const icon = resolveActivityIcon(args, title);
        if (icon) meta.activityIcon = icon;
        if (args?.format) meta.format = args.format;
        if (args?.duration) meta.durationMinutes = args.duration;
        if (args?.availability) meta.availability = args.availability;
        if (args?.guestPicks) meta.guestPicks = args.guestPicks;
        if (args?.recurrence) meta.recurrence = args.recurrence;
        return { linkKind: "personal", linkUrl: url, linkCardMeta: meta };
      }

      if (tc.toolName === "group_event_create") {
        const url = data?.url as string | undefined;
        const title = data?.title as string | undefined;
        const args = tc.input as Record<string, unknown> | undefined;
        const meta: Record<string, unknown> = {};
        if (title) meta.title = title;
        const icon = resolveActivityIcon(args, title);
        if (icon) meta.activityIcon = icon;
        if (args?.format) meta.format = args.format;
        if (args?.durationMinutes) meta.durationMinutes = args.durationMinutes;
        if (args?.inviteeNames) meta.inviteeNames = args.inviteeNames;
        if (args?.windows) meta.windows = args.windows;
        return { linkKind: "group", linkUrl: url, linkCardMeta: meta };
      }
    }
  }
  return null;
}

function inferBucket(toolCallNames: string[]): string {
  if (toolCallNames.length === 0) return "chat";
  const first = toolCallNames[0];
  if (first.startsWith("LOAD_")) return "chat"; // read-only, no write bucket
  if (first.startsWith("personal_link_")) return "event_action";
  if (first.startsWith("bookable_link_")) return "manage_setup";
  if (first.startsWith("group_event_")) return "group_coordination";
  if (first.startsWith("primary_link_")) return "manage_setup";
  if (first.startsWith("session_")) return "event_action";
  if (first.startsWith("rule_")) return "rule";
  if (first.startsWith("prefs_")) return "manage_setup";
  if (first.startsWith("knowledge_")) return "profile";
  return "chat";
}
