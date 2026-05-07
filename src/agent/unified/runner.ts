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

import { streamText, stepCountIs } from "ai";
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
        const { messages: recentMessages, priorToolUseInHistory, priorEnvoyTurnCount } =
          await loadRecentHistory(ctx.channelId);

        // Select model tier — Haiku for short single-turn cases on established
        // channels, Sonnet for cold-channel and multi-step turns, Opus for long.
        const modelSelection = selectModelForTurn({
          messageLength: ctx.message.length,
          priorToolUseInHistory,
          priorEnvoyTurnCount,
        });

        // Stream the unified agent response.
        // Anthropic prompt caching: mark the system prompt as ephemeral so
        // every turn's static prefix (system + tool definitions) hits the
        // cache. 5-min TTL fits typical conversational pacing; cache write
        // happens on first turn, then all reads in the next 5 min are ~10x
        // cheaper. See proposal 2026-05-07_ua-cost-reduction.
        const startMs = Date.now();
        const result = streamText({
          model: envoyModel(modelSelection.modelId),
          messages: [
            {
              role: "system",
              content: SYSTEM_PROMPT,
              providerOptions: {
                anthropic: { cacheControl: { type: "ephemeral" } },
              },
            },
            ...recentMessages,
            { role: "user", content: ctx.message },
          ],
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
        });

        // Consume fullStream progressively — emit text tokens as they arrive
        // so the client sees streaming output rather than waiting for the full
        // response. Status frames fire on tool calls so the UI stays active
        // during multi-step turns (LOAD → write).
        let fullText = "";
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
                  anthropic: { cacheControl: { type: "ephemeral" } },
                },
              },
              ...recentMessages,
              { role: "user", content: ctx.message },
              { role: "assistant", content: fullText },
              {
                role: "user",
                content:
                  `[INTERNAL — self-check flagged your prior response]\n` +
                  `Flagged: ${(selfCheckResult.flaggedTools ?? []).join(", ") || "(unspecified)"}\n` +
                  `Reason: ${selfCheckResult.reason ?? "(unspecified)"}\n\n` +
                  `STRICT OUTPUT RULES (violating any of these is a failure):\n` +
                  `1. Call the right correction tool (update / archive / etc.) FIRST, then emit text.\n` +
                  `2. Output exactly ONE sentence of text. No more.\n` +
                  `3. Do NOT start with "Let me…", "I'll…", "Fixing…", "Let me check…", or any preamble.\n` +
                  `4. Do NOT explain what was wrong. Do NOT name the bad value, the field, or the prior pattern. Do NOT use code/markdown/backticks.\n` +
                  `5. Do NOT apologize. Do NOT say "I made a mistake" or "sorry".\n` +
                  `6. The sentence describes the FINAL CORRECT STATE only — e.g. "Coaching Sessions is now daily, every day 2–5pm." Nothing about the fix journey.\n` +
                  `7. If the issue is purely narrative (no bad write to update), just emit one corrected sentence.\n\n` +
                  `Examples of CORRECT remediation output:\n` +
                  `- "Coaching Sessions is daily now, every day 2–5pm."\n` +
                  `- "Updated Susie's link to 45 minutes."\n` +
                  `- "Founder Dinner now covers May 11–24."\n\n` +
                  `Examples of WRONG output (do NOT do these):\n` +
                  `- "Let me check what was actually created so I can fix it. The link has recurrence.pattern: 'weekly'..." (preamble + exposes internals)\n` +
                  `- "I made a mistake — the pattern should be daily, not weekly. Fixing now." (apology + explanation)\n` +
                  `- "Fixing the recurrence to daily." (preamble word "Fixing")\n`,
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
                durationMs,
                selfCheck: selfCheckResult,
                remediated,
                remediationDurationMs,
              }) as object),
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
  personal_link_create:     "Creating personal link…",
  personal_link_update:     "Updating personal link…",
  personal_link_archive:    "Archiving personal link…",
  personal_link_unarchive:  "Restoring personal link…",
  // Bookable links
  bookable_link_create:     "Creating bookable link…",
  bookable_link_update:     "Updating bookable link…",
  bookable_link_archive:    "Archiving bookable link…",
  bookable_link_unarchive:  "Restoring bookable link…",
  // Group events
  group_event_create:       "Setting up group event…",
  group_event_update:       "Updating group event…",
  group_event_archive:      "Archiving group event…",
  group_event_unarchive:    "Restoring group event…",
  // Primary link
  primary_link_update:      "Updating primary link…",
  // Sessions
  session_update_time:      "Updating session…",
  session_hold_slot:        "Holding slot…",
  session_archive_bulk:     "Archiving sessions…",
  // Rules
  rule_add:                 "Adding rule…",
  rule_update:              "Updating rule…",
  rule_remove:              "Removing rule…",
  // Preferences
  prefs_update_appearance:  "Saving appearance…",
  prefs_update_timezone:    "Saving timezone…",
  knowledge_write:          "Saving note…",
};

function emitText(enqueue: EnqueueFn, content: string): void {
  enqueue(JSON.stringify({ type: "text", content }) + "\n");
}

async function loadRecentHistory(
  channelId: string,
): Promise<{
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  priorToolUseInHistory: boolean;
  priorEnvoyTurnCount: number;
}> {
  // Window cut from 20 → 10 (cost-reduction PR 2026-05-07). 10 turns covers
  // the typical multi-turn conversation; longer-tail context is rarely
  // load-bearing and the savings are ~1,500 tokens per turn.
  const rows = await prisma.channelMessage.findMany({
    where: { channelId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { role: true, content: true, metadata: true },
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
  return { messages, priorToolUseInHistory, priorEnvoyTurnCount };
}

function buildUnifiedMetadata(params: {
  turnCost: TurnCost;
  toolCallNames: string[];
  modelId: string;
  durationMs: number;
  selfCheck: { passed: boolean; flaggedTools?: string[]; reason?: string };
  /** Layer 4 retry: did this turn run a remediation pass after self-check failed? */
  remediated?: boolean;
  /** Wall-clock duration of the remediation streamText call (ms). Null if not remediated. */
  remediationDurationMs?: number | null;
}): Prisma.InputJsonValue {
  const { turnCost, toolCallNames, modelId, durationMs, selfCheck, remediated, remediationDurationMs } = params;

  // Synthesize moduleGuard.bucket from tool names for corpus continuity.
  // Maps tool name prefixes to logical bucket names understood by the dashboard.
  const bucket = inferBucket(toolCallNames);

  return {
    unifiedTurn: {
      model: modelId,
      tier: turnCost.tier,
      promptVersion: PROMPT_VERSION,
      toolCalls: toolCallNames,
      durationMs,
      selfCheck,
      ...(remediated ? { remediated: true, remediationDurationMs } : {}),
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
