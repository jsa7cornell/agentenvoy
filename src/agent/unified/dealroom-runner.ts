/**
 * Deal-room unified-agent runner (Phase A.4).
 *
 * One entry point — `runDealroomTurn(ctx)` — that handles both host and guest
 * speaker roles via the `{{ROLE}}` substitution in `dealroom-unified.md`.
 * The legacy split into separate host/guest runners isn't load-bearing under
 * UA: same `runUnifiedTurn` core, same persistence callback shape, same
 * post-stream-checks; only the speakerRole context flag varies.
 *
 * The route hands us:
 *   - sessionId — pinned to this deal-room thread
 *   - currentMessage — the user message persisted upstream by the route
 *   - speakerRole — derived by the route from NextAuth vs. session.hostId
 *   - viewerTimezone — written to the session on first deal-room render
 *
 * We do:
 *   1. Load the deal-room context (history, GROUND TRUTH, tier signals).
 *   2. Build the role-scoped tool surface (host-allowlist or guest-allowlist).
 *   3. Load the unified system prompt with `{{ROLE}}` substituted.
 *   4. Call `runUnifiedTurn` with a `Message`-table persistence callback.
 *
 * The persistence callback:
 *   - Writes the envoy reply as `role: "administrator"` in `Message`.
 *   - Parses `[DELEGATE_SPEAKER]` from prose and writes it to the upstream
 *     guest message's metadata (per handoff §6.3).
 *   - Strips action-blocks from prose before persisting (legacy block syntax
 *     is no longer emitted under UA, but `[DELEGATE_SPEAKER]` + future
 *     `[TIMEZONE_SWITCH]` blocks still get stripped for clean display).
 *
 * Wired into `/api/negotiate/message/route.ts` unconditionally as of
 * 2026-05-13 (the `DEALROOM_UNIFIED_ENABLED` kill-switch flag from Phase
 * A.6 was deleted; the deal-room runs unified-agent for every turn).
 *
 * Refs:
 *   - proposals/2026-05-11_complete-unified-agent-migration-and-retire-classifier-composer_reviewed-2026-05-11_decided-2026-05-11.md §2 + §3.2
 *   - handoffs/_phase-a-implementation-plan_2026-05-11.md §A.4 + §2 (persistence shape diff)
 */

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { runUnifiedTurn } from "./runner";
import { buildUnifiedToolsFor, type AgentToolContext } from "./tools";
import type { LoadResultShape } from "./grounding-check";
import type { GroundingFire } from "./tool-impls/_exec";
import { dealroomUnifiedSystemPrompt } from "@/agent/runtime-prompts";
import {
  loadDealroomContext,
  type DealroomSpeakerRole,
} from "./dealroom-context-loader";

/**
 * Request context the route hands us. Mirrors the legacy
 * `negotiate/message/route.ts` body parsing.
 */
export type DealroomTurnContext = {
  /** Active deal-room session id. */
  sessionId: string;
  /** Speaker role for this turn — derived by the route from auth. */
  speakerRole: DealroomSpeakerRole;
  /** The user's message — already persisted to `Message` by the route. */
  currentMessage: string;
};

const VALID_INLINE_BLOCK_PATTERNS = [
  // [STATUS_UPDATE]{...}[/STATUS_UPDATE] — retired in favor of session_set_status,
  // but strip in case the model emits the legacy shape during the migration window.
  /\s*\[STATUS_UPDATE\][\s\S]*?\[\/STATUS_UPDATE\]\s*/g,
  // [DELEGATE_SPEAKER]{...}[/DELEGATE_SPEAKER] — extracted before strip for the
  // upstream-message metadata write; see parseAndStripDelegateSpeaker below.
  /\s*\[DELEGATE_SPEAKER\][\s\S]*?\[\/DELEGATE_SPEAKER\]\s*/g,
  // [TIMEZONE_SWITCH]{...}[/TIMEZONE_SWITCH] — handled by frontend; strip here so
  // it doesn't leak into the persisted text.
  /\s*\[TIMEZONE_SWITCH\][\s\S]*?\[\/TIMEZONE_SWITCH\]\s*/g,
] as const;

function stripInlineBlocks(text: string): string {
  let out = text;
  for (const pattern of VALID_INLINE_BLOCK_PATTERNS) {
    out = out.replace(pattern, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

const DELEGATE_KINDS = new Set(["human_assistant", "ai_agent", "unknown"]);

function parseDelegateSpeaker(text: string): { kind: string; name?: string } | null {
  const match = text.match(/\[DELEGATE_SPEAKER\]([\s\S]*?)\[\/DELEGATE_SPEAKER\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { kind?: unknown; name?: unknown };
    if (typeof parsed.kind !== "string" || !DELEGATE_KINDS.has(parsed.kind)) return null;
    const name =
      typeof parsed.name === "string" && parsed.name.length > 0 && parsed.name.length <= 80
        ? parsed.name
        : undefined;
    return { kind: parsed.kind, name };
  } catch {
    return null;
  }
}

/**
 * Build a deal-room unified-agent stream. Same NDJSON wire shape as
 * `runUnifiedAgent` so the route can return the result directly.
 */
export function runDealroomTurn(ctx: DealroomTurnContext): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      try {
        // 1. Load context: history, GROUND TRUTH lines, tier signals.
        const ctxOut = await loadDealroomContext({
          sessionId: ctx.sessionId,
          speakerRole: ctx.speakerRole,
          currentMessage: ctx.currentMessage,
        });

        // ── Per-turn accumulators for grounding-check value-match + telemetry ──
        // 2026-05-12 grounding-check-evidence-scope-redesign (PR-C, deal-room):
        // parallels PR-B's host-channel plumbing. Closure-captured mutables
        // populated as LOAD tools fire; consumed by the grounding check's
        // value-match logic + (PR-D) unifiedTurn metadata.
        const thisTurnToolResults: LoadResultShape[] = [];
        const groundingFires: GroundingFire[] = [];

        // recentThread: extract prior user + envoy turn from the 2-turn preload.
        // When historyTrimmedForStaleness fired upstream, ctxOut.history is
        // empty → recentThread is undefined → recentThread-scoped grounding-
        // check fields surface the distinctive "stale context" error.
        const recentThread: AgentToolContext["recentThread"] =
          ctxOut.session.historyTrimmedForStaleness || ctxOut.history.length === 0
            ? undefined
            : {
                priorUserTurn: ctxOut.history.find((m) => m.role === "user")?.content,
                priorEnvoyTurn: ctxOut.history.find((m) => m.role === "assistant")?.content,
              };

        // 2. Build the role-scoped tool surface. The host-channel agent
        //    context fields (`timezone`, `meetSlug`) come from the session's
        //    host — the unified tools' execute closures need them for
        //    request-scoped tool dispatch.
        const agentCtx: AgentToolContext = {
          userId: ctxOut.session.hostId,
          timezone: ctxOut.session.hostTimezone,
          // meetSlug is N/A for deal-room writes (sessionId scopes everything).
          userMessage: ctx.currentMessage,
          recentThread,
          getThisTurnToolResults: () => thisTurnToolResults,
          recordToolResult: (toolName, result) => {
            thisTurnToolResults.push({ toolName, result } as LoadResultShape);
          },
          recordGroundingFire: (fire) => {
            groundingFires.push(fire);
          },
          // 2026-05-14 cmp51ltr5: thread the speakerRole down through tool
          // dispatch so handlers can branch on guest vs. host caller
          // (e.g., session_lock_duration's guest-shrink bypass).
          triggeringRole: ctx.speakerRole,
        };
        const role: "dealroom-host" | "dealroom-guest" =
          ctx.speakerRole === "host" ? "dealroom-host" : "dealroom-guest";
        const tools = buildUnifiedToolsFor({
          role,
          agentCtx,
          dealroomCtx: {
            sessionId: ctxOut.session.id,
            hostId: ctxOut.session.hostId,
            role,
          },
        }) as Parameters<typeof runUnifiedTurn>[0]["tools"];

        // 3. Load + substitute the system prompt.
        const promptRaw = dealroomUnifiedSystemPrompt({ role: ctx.speakerRole });
        // Prepend GROUND TRUTH lines so they sit above the prompt body.
        // Order: [SESSION_ID], [HOST_TZ], [VIEWER_TZ?], [LOCKED]*, [SESSION_LIVE_EVENT?],
        //        [PARSED_TIMES?]. See dealroom-context-loader for assembly.
        const systemPrompt =
          ctxOut.groundTruthLines.length > 0
            ? [...ctxOut.groundTruthLines, "", promptRaw].join("\n")
            : promptRaw;

        // 4. Run the unified turn with the Message-table persistence callback.
        await runUnifiedTurn({
          userId: ctxOut.session.hostId,
          userMessage: ctx.currentMessage,
          // Anchor the date-context prefix to the host's TZ. The deal-room
          // system prompt already conveys guest TZ via [VIEWER_TZ] when
          // relevant; "today" is canonically the host's today for scheduling
          // effects. cmp50uvuq fix, 2026-05-14.
          timezone: ctxOut.session.hostTimezone,
          systemPrompt,
          tools,
          recentMessages: ctxOut.history,
          priorToolUseInHistory: ctxOut.session.priorToolUseInHistory,
          priorEnvoyTurnCount: ctxOut.session.priorEnvoyTurnCount,
          priorEnvoyTurnAgeMs: ctxOut.session.priorEnvoyTurnAgeMs,
          historyTrimmedForStaleness: ctxOut.session.historyTrimmedForStaleness,
          getGroundingFires: () => groundingFires,
          enqueue,
          persistEnvoyMessage: async ({ content, metadata }) => {
            // Strip inline blocks (delegate-speaker, status-update, tz-switch)
            // from the persisted text. The blocks are parsed BEFORE strip when
            // a side-effect is needed (delegate-speaker → upstream message).
            const delegateSpeaker = parseDelegateSpeaker(content);
            const cleanContent = stripInlineBlocks(content);

            await prisma.message.create({
              data: {
                sessionId: ctxOut.session.id,
                role: "administrator",
                content: cleanContent,
                metadata: metadata as Prisma.InputJsonValue,
              },
            });

            // Attach delegate-speaker metadata to the most-recent guest
            // message (per the 2026-04-19 external_agent microspec + the
            // 2026-04-21 delegate-speaker annotation rule). The block
            // describes the INCOMING guest message's speaker, not this
            // reply's.
            if (delegateSpeaker) {
              const lastGuest = await prisma.message.findFirst({
                where: { sessionId: ctxOut.session.id, role: "guest" },
                orderBy: { createdAt: "desc" },
              });
              if (lastGuest) {
                const existing =
                  (lastGuest.metadata as Record<string, unknown> | null) ?? {};
                await prisma.message.update({
                  where: { id: lastGuest.id },
                  data: {
                    metadata: {
                      ...existing,
                      delegateSpeaker,
                    } as Prisma.InputJsonValue,
                  },
                });
              }
            }
          },
        });

        controller.close();
      } catch (err) {
        console.error("[dealroom-runner] stream error:", err);
        // runUnifiedTurn already emits narrateFinalizeError + rethrows on
        // its own stream errors; this catch handles errors BEFORE the
        // stream started (context-load + tool-build + prompt-load).
        try {
          enqueue(
            JSON.stringify({
              type: "text",
              content: "⚠️ Something went wrong wrapping that up. Try again, or reach out if it keeps happening.",
            }) + "\n",
          );
          controller.close();
        } catch {
          try { controller.error(err); } catch { /* already closed */ }
        }
      }
    },
  });
}
