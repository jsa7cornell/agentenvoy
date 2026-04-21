import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { getOrComputeSchedule } from "@/lib/calendar";
import { formatComputedSchedule, formatOfferableSlots } from "@/agent/composer";
import { getUserTimezone, shortTimezoneLabel } from "@/lib/timezone";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";
import type { ActionRequest, ActionResult } from "@/agent/actions";
import { narrateFailures, narrateTimeout, narrateFinalizeError } from "@/agent/action-narration";
import { sanitizeHistory } from "@/lib/conversation";
import { mergeChannelMetadata } from "@/lib/channel/metadata-schema";
import type { ChannelMessageMetadata } from "@/lib/channel/metadata-schema";
import { needsActionEmissionRetry, ACTION_EMISSION_RETRY_PROMPT } from "@/agent/action-emission-guard";
import {
  selectVariant,
  type ProgressStage,
  type ProgressExecutingAction,
  type ProgressCopyInterpolation,
} from "@/agent/progress-copy";
import { runWithStageRotation } from "@/agent/progress-rotation";
import { readFileSync } from "fs";
import { join } from "path";

// Load playbooks once at module scope (same pattern as composer.ts)
let personaPlaybook = "";
let channelPlaybook = "";
try {
  personaPlaybook = readFileSync(join(process.cwd(), "src", "agent", "playbooks", "persona.md"), "utf-8");
} catch (e) {
  console.error("Failed to load persona.md for channel chat:", e);
}
try {
  channelPlaybook = readFileSync(join(process.cwd(), "src", "agent", "playbooks", "channel.md"), "utf-8");
} catch (e) {
  console.error("Failed to load channel.md for channel chat:", e);
  throw e;
}

const CHANNEL_SYSTEM = `${personaPlaybook ? personaPlaybook + "\n\n---\n\n" : ""}${channelPlaybook}`;

// ---------------------------------------------------------------------------
// Progress narration protocol (proposal decided 2026-04-21)
//
// Response body is JSON-lines over the existing chunked HTTP response:
//   {"type":"status","stage":"...","copy":"...","seq":N}
//   {"type":"text","content":"..."}
//
// Buffer-mode invariant from narration-hygiene-v2 preserved: the `text` frame
// is emitted in ONE shot after all actions resolve. Status frames are cosmetic
// and describe what's happening server-side, not what the LLM is saying.
//
// Caps (§2.1 + §10 decision #3):
//   - 6 frames total per turn.
//   - Retry frames capped at 2; normal-stage frames elided first to stay under 6.
// ---------------------------------------------------------------------------
const MAX_FRAMES_PER_TURN = 6;
const MAX_RETRY_FRAMES_PER_TURN = 2;

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parallel group 1: user lookup + body parse
    const [user, body] = await Promise.all([
      prisma.user.findUnique({
        where: { email: session.user.email },
        select: {
          id: true,
          name: true,
          email: true,
          meetSlug: true,
          preferences: true,
          persistentKnowledge: true,
          upcomingSchedulePreferences: true,
          hostDirectives: true,
          lastCalibratedAt: true,
        },
      }),
      req.json(),
    ]);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const safeUser = user;
    const { message } = body;

    // Get or create channel
    let channel = await prisma.channel.findUnique({ where: { userId: safeUser.id } });
    if (!channel) {
      channel = await prisma.channel.create({ data: { userId: safeUser.id } });
    }
    const safeChannel = channel;

    // Count prior envoy messages on this channel — used as the turn-index seed
    // component for copy rotation (§2.2 selection rules, N4 fold). Scoped to
    // userId + turn-index-within-chat-thread so variants rotate feelingly per
    // turn but pin deterministic in tests.
    const priorEnvoyTurns = await prisma.channelMessage.count({
      where: { channelId: safeChannel.id, role: "envoy" },
    });

    // Set up the JSON-lines stream now so we can emit status frames around
    // every pipeline stage. The emitter closure is passed into the pipeline.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let framesEmitted = 0;
        let retryFramesEmitted = 0;
        let seq = 0;
        const usedIndicesByStage = new Map<string, Set<number>>();

        const emitStatus = (
          stage: ProgressStage,
          options: {
            action?: ProgressExecutingAction;
            slots?: ProgressCopyInterpolation;
            withinStageIndex?: number;
          } = {},
        ): boolean => {
          try {
            const isRetry = stage === "retrying";
            if (isRetry && retryFramesEmitted >= MAX_RETRY_FRAMES_PER_TURN) return false;
            // Overall cap — retries get priority (proposal §2.1 "retries have
            // priority" + John's §10 #3 decision). Non-retry frames are capped
            // at (overall cap − retry reservation), leaving headroom for up to
            // MAX_RETRY_FRAMES_PER_TURN retry frames even late in the turn.
            if (!isRetry) {
              const reserve = Math.max(0, MAX_RETRY_FRAMES_PER_TURN - retryFramesEmitted);
              if (framesEmitted >= MAX_FRAMES_PER_TURN - reserve) return false;
            } else {
              if (framesEmitted >= MAX_FRAMES_PER_TURN) return false;
            }

            const usedKey = `${stage}:${options.action ?? ""}`;
            const used = usedIndicesByStage.get(usedKey) ?? new Set<number>();
            const picked = selectVariant({
              stage,
              action: options.action,
              slots: options.slots,
              userId: safeUser.id,
              turnIndex: priorEnvoyTurns,
              withinStageIndex: options.withinStageIndex ?? 0,
              usedIndices: used,
            });
            if (!picked) return false;
            used.add(picked.index);
            usedIndicesByStage.set(usedKey, used);
            seq += 1;
            framesEmitted += 1;
            if (isRetry) retryFramesEmitted += 1;
            const frame = {
              type: "status",
              stage,
              copy: picked.copy,
              seq,
              ...(options.action ? { action: options.action } : {}),
            };
            controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
            return true;
          } catch (e) {
            // Status emission must never break the turn.
            console.error("[channel/chat] emitStatus error:", e);
            return false;
          }
        };

        const withStageRotation = <T>(
          stage: ProgressStage,
          operation: () => Promise<T>,
          options: { slots?: ProgressCopyInterpolation } = {},
        ) => runWithStageRotation(emitStatus, stage, operation, options);

        try {
          // Detect if the host is asking us to re-check / refresh calendar
          const lowerMsg = message.toLowerCase();
          const isRefreshRequest = /\b(check again|re-?check|refresh|re-?pull|changed my (schedule|calendar)|updated my (schedule|calendar)|look again|try again|one more time)\b/i.test(lowerMsg);

          // Stage 1: scanning-calendar — fires BEFORE parallel-group-2. The
          // group does more than just fetch schedule but the calendar read is
          // the dominant wait, so we anchor the frame here (§2.1 table).
          // Within-stage rotation ticks every WITHIN_STAGE_ROTATION_MS while
          // getOrComputeSchedule is in flight (proposal §2.2 R2 fold).
          const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
          const now = new Date();

          const [, sessionResult, scheduleResult, activeSessions] = await Promise.all([
            prisma.channelMessage.create({
              data: { channelId: safeChannel.id, role: "user", content: message },
            }),
            prisma.channelSession.findFirst({
              where: { channelId: safeChannel.id, closed: false },
              orderBy: { startedAt: "desc" },
            }),
            withStageRotation("scanning-calendar", () =>
              getOrComputeSchedule(safeUser.id, { forceRefresh: isRefreshRequest }),
            ).catch((e) => {
              console.log("Schedule context error:", e);
              return null;
            }),
            prisma.negotiationSession.findMany({
              where: { hostId: safeUser.id, archived: false },
              include: {
                link: {
                  select: {
                    inviteeName: true,
                    inviteeEmail: true,
                    topic: true,
                    code: true,
                    slug: true,
                  },
                },
              },
              orderBy: { updatedAt: "desc" },
              take: 20,
            }),
          ]);

          // --- Channel session lifecycle (3-day rolling window) ---
          let activeSession = sessionResult;

          if (activeSession && activeSession.expiresAt < now) {
            const expiredSessionId = activeSession.id;
            const expiredSessionStart = activeSession.startedAt;
            await prisma.channelSession.update({
              where: { id: expiredSessionId },
              data: { closed: true },
            });

            void (async () => {
              try {
                const recentMsgs = await prisma.channelMessage.findMany({
                  where: {
                    channelId: safeChannel.id,
                    createdAt: { gte: expiredSessionStart },
                  },
                  orderBy: { createdAt: "asc" },
                  take: 30,
                });
                const summaryText = recentMsgs
                  .filter((m) => m.role !== "system")
                  .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
                  .join("\n");

                const summaryResult = await generateText({
                  model: envoyModel("claude-sonnet-4-6"),
                  maxOutputTokens: 512,
                  system: "Summarize this scheduling conversation in 2-3 sentences. Focus on what was decided, what's pending, and any preferences learned.",
                  messages: [{ role: "user", content: summaryText }],
                });
                await prisma.channelSession.update({
                  where: { id: expiredSessionId },
                  data: { summary: summaryResult.text },
                });
              } catch (e) {
                console.error("[channel/chat] Background summarization failed:", e);
              }
            })();

            activeSession = null;
          }

          if (!activeSession) {
            activeSession = await prisma.channelSession.create({
              data: {
                channelId: safeChannel.id,
                expiresAt: new Date(Date.now() + THREE_DAYS_MS),
              },
            });
          } else {
            await prisma.channelSession.update({
              where: { id: activeSession.id },
              data: { expiresAt: new Date(Date.now() + THREE_DAYS_MS) },
            });
          }

          // Build context
          const contextParts: string[] = [];
          contextParts.push(`User: ${user.name || "User"}`);

          let calendarConnected = false;
          const hostPrefs = user.preferences as Record<string, unknown> | null;
          const tz = getUserTimezone(hostPrefs);
          const tzLabel = shortTimezoneLabel(tz);
          let scoredSlotCount = 0;
          if (scheduleResult?.connected) {
            calendarConnected = true;
            scoredSlotCount = scheduleResult.slots?.length ?? 0;
            contextParts.push(
              formatComputedSchedule(scheduleResult.slots, tz, scheduleResult.canWrite, undefined, {
                weekConvention: "sun_start",
              }),
            );
            contextParts.push(formatOfferableSlots(scheduleResult.slots, tz, scheduleResult.canWrite));
          }
          if (!calendarConnected) {
            contextParts.push("Calendar: Not connected");
          }

          if (user.persistentKnowledge) {
            contextParts.push(`Host's persistent preferences:\n${user.persistentKnowledge}`);
          }
          if (user.upcomingSchedulePreferences) {
            contextParts.push(`Host's situational context (near-term):\n${user.upcomingSchedulePreferences}`);
          }
          if (user.hostDirectives && (user.hostDirectives as string[]).length > 0) {
            contextParts.push(`Host directives (highest priority):\n${(user.hostDirectives as string[]).map(d => `- ${d}`).join("\n")}`);
          }

          if (activeSessions.length > 0) {
            const sessionList = activeSessions.map(s => {
              const guest = s.link.inviteeName || s.guestEmail || "unknown";
              const note = s.statusLabel ? `, note: ${s.statusLabel}` : "";
              const code = s.link.code ?? null;
              const url = s.link.slug && s.link.code
                ? `/meet/${s.link.slug}/${s.link.code}`
                : null;
              const ids = [
                `sessionId: ${s.id}`,
                code ? `linkCode: ${code}` : null,
                url ? `url: ${url}` : null,
              ].filter(Boolean).join(", ");
              return `- "${s.title || 'Untitled'}" (${ids}) — status: ${s.status}, guest: ${guest}${note}`;
            }).join('\n');
            contextParts.push(
              `Active sessions:\n${sessionList}\n\n` +
              `You can execute actions on these sessions using [ACTION] blocks. ` +
              `For session-scoped actions (update_format / update_time / update_location / cancel / hold_slot / archive) pass sessionId. ` +
              `For link-scoped actions (update_link / expand_link) pass linkCode — it's the 6-char string after /meet/{slug}/ in the url above.`
            );
          } else {
            contextParts.push("Active sessions: None");
          }

          const timeStr = now.toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
            timeZone: tz,
          });
          contextParts.push(`Current time: ${timeStr}`);

          if (!user.lastCalibratedAt) {
            contextParts.push("Calibration: NEVER — this host has not been calibrated. Run onboarding calibration (see ONBOARDING CALIBRATION below).");
          } else {
            const daysSince = Math.floor((Date.now() - new Date(user.lastCalibratedAt).getTime()) / (1000 * 60 * 60 * 24));
            if (daysSince >= 10) {
              contextParts.push(`Calibration: Last calibrated ${daysSince} days ago. Consider running a check-in (see CHECK-IN CALIBRATION below).`);
            } else {
              contextParts.push(`Calibration: Last calibrated ${daysSince} day${daysSince !== 1 ? "s" : ""} ago.`);
            }
          }

          // Stage 2: scoring — between schedule result and LLM call. Slot data
          // available here: `{count}` (scored slot count) and `{tz}` (host tz).
          emitStatus("scoring", {
            slots: {
              ...(scoredSlotCount > 0 ? { count: String(scoredSlotCount) } : {}),
              ...(tzLabel ? { tz: tzLabel } : {}),
            },
          });

          const threeDaysAgo = new Date(Date.now() - THREE_DAYS_MS);
          const sessionStart = new Date(activeSession.startedAt.getTime() - 5000);
          const historyStart = sessionStart > threeDaysAgo ? sessionStart : threeDaysAgo;
          const history = await prisma.channelMessage.findMany({
            where: {
              channelId: safeChannel.id,
              createdAt: { gte: historyStart },
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          });
          history.reverse();

          const { messages, warnings } = sanitizeHistory(
            history.map(m => ({ role: m.role, content: m.content })),
            ["envoy", "assistant"]
          );
          if (warnings.length > 0) {
            console.warn(`[channel/chat] History sanitized | userId=${safeUser.id} | ${warnings.join("; ")}`);
          }

          const system = CHANNEL_SYSTEM + "\n\nCONTEXT:\n" + contextParts.join("\n");
          const modelId = "claude-sonnet-4-6";

          // Stage 3: thinking — just before generateText. Within-stage
          // rotation ticks while the LLM is generating (proposal §2.2 R2).
          const first = await withStageRotation("thinking", () =>
            generateText({
              model: envoyModel(modelId),
              maxOutputTokens: 1024,
              system,
              messages,
            }),
          );
          let fullText = first.text;

          if (needsActionEmissionRetry(fullText)) {
            console.warn(
              `[channel/chat] intent-without-emit detected for user ${safeUser.id}, forcing retry`
            );
            // Emit retry frame (capped at 2 per turn).
            emitStatus("retrying");
            const retry = await generateText({
              model: envoyModel(modelId),
              maxOutputTokens: 512,
              system,
              messages: [
                ...messages,
                { role: "assistant", content: fullText },
                { role: "user", content: ACTION_EMISSION_RETRY_PROMPT },
              ],
            });
            if (retry.text.trim()) {
              fullText += "\n\n" + retry.text;
            }
          }

          // --- Stage 4/5/6: inline action + finalization pipeline ---
          // Preserves the buffer-mode invariant from narration-hygiene-v2:
          // the `text` frame is only emitted AFTER all actions resolve and
          // failure narration (if any) has replaced the LLM draft inline.
          const ACTION_TIMEOUT_MS = 15_000;
          // Prompt snapshot default-on (proposal Q8). Host can opt out by
          // setting PROMPT_SNAPSHOT_ENABLED=false — a reader noticing missing
          // promptContext on incident turns should check this env first.
          const promptSnapshotEnabled =
            process.env.PROMPT_SNAPSHOT_ENABLED !== "false";
          const buildEnvoyMetadata = (
            actions: ActionRequest[],
            actionResults: ActionResult[],
            base?: Record<string, unknown>,
          ): ChannelMessageMetadata => {
            const additions: Partial<ChannelMessageMetadata> = {};
            if (actions.length > 0) {
              additions.actions = actions.map((a) => ({
                action: a.action,
                params: (a.params ?? {}) as Record<string, unknown>,
              }));
              additions.actionResults = actions.map((a, i) => {
                const r = actionResults[i];
                if (!r) {
                  return { action: a.action, success: false, message: "timed_out" };
                }
                return {
                  action: a.action,
                  success: r.success,
                  message: r.message,
                  ...(r.data ? { data: r.data } : {}),
                };
              });
            }
            if (promptSnapshotEnabled) {
              additions.promptContext = {
                systemPrompt: CHANNEL_SYSTEM,
                contextBlock: contextParts.join("\n"),
                modelId,
              };
            }
            return mergeChannelMetadata(base ?? null, additions);
          };
          const finalizeResponse = async (text: string): Promise<string> => {
            try {
              const actions = parseActions(text);
              let actionResults: ActionResult[] = [];
              let timedOut = false;
              if (actions.length > 0) {
                // Stage 4: drafting — before executeActions, keyed to first
                // action's guest (when available from params).
                const firstAction = actions[0];
                const draftSlots = slotsFromAction(firstAction);
                emitStatus("drafting", { slots: draftSlots });

                const onActionStart = (action: ActionRequest, index: number) => {
                  // Stage 5: executing — one frame per action, up to the cap.
                  const slots = slotsFromAction(action);
                  emitStatus("executing", {
                    action: action.action as ProgressExecutingAction,
                    slots,
                    withinStageIndex: index,
                  });
                };

                const execPromise = executeActions(actions, safeUser.id, {
                  meetSlug: safeUser.meetSlug || undefined,
                  onActionStart,
                });
                const timeoutPromise = new Promise<"__TIMEOUT__">((resolve) =>
                  setTimeout(() => resolve("__TIMEOUT__"), ACTION_TIMEOUT_MS),
                );
                const raced = await Promise.race([execPromise, timeoutPromise]);
                if (raced === "__TIMEOUT__") {
                  timedOut = true;
                  execPromise
                    .then((r) => console.warn(`[channel/chat] late action completion user=${safeUser.id} results=${r.map(x => x.success ? "ok" : "fail").join(",")}`))
                    .catch((e) => console.error(`[channel/chat] late action error user=${safeUser.id}:`, e));
                } else {
                  actionResults = raced;
                }
              }

              // Stage 6: finalizing — after action results, before DB write.
              emitStatus("finalizing");

              let displayText = stripActionBlocks(text);
              displayText = displayText.replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "").trim();

              let overriddenNarration: string | null = null;
              if (timedOut) {
                overriddenNarration = displayText || null;
                displayText = narrateTimeout();
              } else {
                const failedResults = actionResults.filter((r) => !r.success);
                if (failedResults.length > 0) {
                  overriddenNarration = displayText || null;
                  displayText = narrateFailures(actions, actionResults, displayText);
                }
              }

              const baseOverride = overriddenNarration
                ? { overriddenNarration }
                : null;
              const envoyMetadata = buildEnvoyMetadata(
                actions,
                actionResults,
                baseOverride ?? undefined,
              );

              const createLinkResult = actionResults.find((r) => r.success && r.data?.url);
              if (createLinkResult?.data) {
                const d = createLinkResult.data;
                const envoyText = displayText || createLinkResult.message;
                await prisma.channelMessage.create({
                  data: {
                    channelId: safeChannel.id,
                    role: "envoy",
                    content: envoyText,
                    threadId: d.sessionId as string,
                    metadata: envoyMetadata as Prisma.InputJsonValue,
                  },
                });
                return envoyText;
              }

              const threadedResult = actionResults.find(
                (r) => r.success && typeof r.data?.sessionId === "string",
              );
              if (threadedResult?.data) {
                const sid = threadedResult.data.sessionId as string;
                const summary =
                  actionResults.length > 0
                    ? actionResults
                        .map((r) => `${r.success ? "\u2713" : "\u2717"} ${r.message}`)
                        .join("\n")
                    : "";
                const envoyText = displayText || threadedResult.message;
                await prisma.channelMessage.create({
                  data: {
                    channelId: safeChannel.id,
                    role: "envoy",
                    content: envoyText,
                    threadId: sid,
                    metadata: envoyMetadata as Prisma.InputJsonValue,
                  },
                });
                if (summary && displayText) {
                  await prisma.channelMessage.create({
                    data: { channelId: safeChannel.id, role: "system", content: summary },
                  });
                }
                return envoyText;
              }

              if (actionResults.length > 0) {
                const summary = actionResults
                  .map((r) => `${r.success ? "\u2713" : "\u2717"} ${r.message}`)
                  .join("\n");
                if (!displayText) {
                  displayText = summary;
                } else {
                  await prisma.channelMessage.create({
                    data: { channelId: safeChannel.id, role: "system", content: summary },
                  });
                }
              }

              const finalText = displayText || text || "Done.";
              await prisma.channelMessage.create({
                data: {
                  channelId: safeChannel.id,
                  role: "envoy",
                  content: finalText,
                  metadata: envoyMetadata as Prisma.InputJsonValue,
                },
              });
              return finalText;
            } catch (e) {
              console.error("[channel/chat] finalizeResponse error:", e);
              const fallback = narrateFinalizeError();
              try {
                await prisma.channelMessage.create({
                  data: { channelId: safeChannel.id, role: "envoy", content: fallback },
                });
              } catch {
                // swallow — already in an error path
              }
              return fallback;
            }
          };

          const clientText = await finalizeResponse(fullText);

          // Final text frame — atomic, after all actions and narration rewrite.
          controller.enqueue(
            encoder.encode(JSON.stringify({ type: "text", content: clientText }) + "\n"),
          );
          controller.close();
        } catch (e) {
          console.error("[channel/chat] stream start error:", e);
          try {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ type: "text", content: narrateFinalizeError() }) + "\n",
              ),
            );
            controller.close();
          } catch {
            try { controller.error(e); } catch { /* already closed */ }
          }
        }
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`[channel/chat] Unhandled error: ${err.message}`, err.stack);
    return NextResponse.json(
      { error: "Something went wrong", detail: err.message, retryable: true },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract ProgressCopy slot values from an action's params. Per-action specific
 * copy (§10 decision #7) — we surface `{guest}` and `{day}` when the action's
 * params carry them, generic fallback otherwise.
 *
 * PII contract: only the closed-union slots may be emitted. Preferences /
 * directives / knowledge fields are deliberately not considered here.
 */
function slotsFromAction(action: ActionRequest): ProgressCopyInterpolation {
  const p = action.params as Record<string, unknown>;
  const slots: ProgressCopyInterpolation = {};
  const guestRaw =
    (typeof p.inviteeName === "string" && p.inviteeName) ||
    (typeof p.guestName === "string" && p.guestName) ||
    null;
  if (guestRaw) {
    // First-name preferred (§2.2 slot-fill examples).
    slots.guest = String(guestRaw).trim().split(/\s+/)[0];
  }
  const dayRaw =
    (typeof p.day === "string" && p.day) ||
    (typeof p.date === "string" && p.date) ||
    (typeof p.time === "string" && p.time) ||
    null;
  if (dayRaw) slots.day = String(dayRaw);
  return slots;
}
