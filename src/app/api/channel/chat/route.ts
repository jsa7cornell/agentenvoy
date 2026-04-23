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
import { classifyChatIntent } from "@/agent/intent-classifier";
import { isEchoOfRecentEnvoy } from "@/lib/echo-detect";
import { normalizeChatIntent, type ChatIntent, type ChatIntentBlock } from "@/lib/intent";
import { runDispatchHandler } from "@/agent/dispatch-handler";
import { computeProfileGaps } from "@/lib/profile-gaps";
import type { CalendarEvent } from "@/lib/calendar";

function formatUpcomingEvents(events: CalendarEvent[], tz: string): string | null {
  const now = Date.now();
  const cutoff = now + 14 * 24 * 60 * 60 * 1000;
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: tz, hour12: true,
  });
  const relevant = events
    .filter((e) => {
      if (!e.summary || e.summary === "(no title)") return false;
      const start = new Date(e.start).getTime();
      return start >= now && start <= cutoff;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 15);
  if (relevant.length === 0) return null;
  const lines = relevant.map((e) => {
    const startLabel = dateFmt.format(new Date(e.start));
    const attendeePart = (e.attendeeCount ?? 0) > 1
      ? ` (${e.attendeeCount} guests)`
      : "";
    return `- "${e.summary}" — ${startLabel}${attendeePart}`;
  });
  return `Upcoming calendar events (next 14 days — use these to resolve cancel/reschedule requests by name):\n${lines.join("\n")}`;
}

// Load playbooks once at module scope (same pattern as composer.ts)
let personaPlaybook = "";
let channelPlaybook = "";
let inquirePlaybook = "";
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
try {
  inquirePlaybook = readFileSync(join(process.cwd(), "src", "agent", "playbooks", "inquire.md"), "utf-8");
} catch (e) {
  console.error("Failed to load inquire.md for channel chat:", e);
  // Inquire playbook is new; fall back cleanly if it's missing rather than
  // crash the module. The dispatch layer treats an empty playbook as "no
  // guidance" and the scheduling path continues to work.
  inquirePlaybook = "";
}

const CHANNEL_SYSTEM = `${personaPlaybook ? personaPlaybook + "\n\n---\n\n" : ""}${channelPlaybook}`;
const INQUIRE_SYSTEM = `${personaPlaybook ? personaPlaybook + "\n\n---\n\n" : ""}${inquirePlaybook}`;

// Profile + rule tiers route through `runDispatchHandler` (Proposal 3,
// decided 2026-04-21). Each tier loads a narrower playbook
// (profile.md / rule.md) and emits the shorter `thinking → executing →
// finalizing` taxonomy — no calendar scan or slot scoring.

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
    const { message, userIntentHint: rawIntentHint } = body as {
      message: string;
      userIntentHint?: unknown;
    };
    // Hint from a clarifier quick-reply click — bypasses the classifier.
    // Proposal §2.4, §2.6. Stub tiers are NOT accepted as hints (schema
    // §2.2 restricts quick-replies to live tiers only).
    const hintedIntent: ChatIntent | null = (() => {
      const n = normalizeChatIntent(rawIntentHint);
      if (n === "schedule" || n === "inquire") return n;
      return null;
    })();

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

          // ------------------------------------------------------------
          // Split-pass intent router (proposal 2026-04-21, decided 2026-
          // 04-21 pm). Haiku classifier runs ahead of the scheduling pass
          // so channel.md stays untouched. Stub/unclear tiers short-
          // circuit without loading the calendar.
          // ------------------------------------------------------------

          // Persist user message immediately — independent of the tier
          // decision. Fire and await so stub/unclear tiers still capture
          // the utterance in channel history.
          const userMsgPersist = prisma.channelMessage.create({
            data: { channelId: safeChannel.id, role: "user", content: message },
          });

          // Run classifier in parallel with the user-message persist
          // unless a quick-reply hint is present (then bypass entirely).
          let intentBlock: ChatIntentBlock;
          let classifierLatencyMs = 0;
          let classifierRetried = false;
          let rawClassifierKind: string | null = null;
          let fabricationDetected = false;
          let echoFlag = false;
          if (hintedIntent) {
            intentBlock = { kind: hintedIntent };
          } else {
            // Build a lightweight context snapshot for the classifier —
            // active session titles help it resolve pronouns like "move
            // it to Tuesday" (proposal §2.2 buildUserPrompt). Short by
            // design: the classifier is cheap but not free.
            const recentSessions = await prisma.negotiationSession.findMany({
              where: { hostId: safeUser.id, archived: false, status: { not: "cancelled" } },
              select: {
                id: true,
                title: true,
                guestEmail: true,
                link: { select: { inviteeName: true } },
              },
              orderBy: { updatedAt: "desc" },
              take: 5,
            });
            const activeSessionsSummary = recentSessions
              .map((s) => {
                const guest = s.link?.inviteeName || s.guestEmail || "unknown";
                return `- "${s.title || "Untitled"}" (guest: ${guest})`;
              })
              .join("\n");

            // Fetch last 3 envoy messages to feed the deterministic echo
            // detector (proposal §4.4) AND to plumb `priorEnvoyTurn` into
            // the classifier context (proposal §4.1 / PR-α). Most-recent-first.
            const recentEnvoy = await prisma.channelMessage.findMany({
              where: { channelId: safeChannel.id, role: "envoy" },
              orderBy: { createdAt: "desc" },
              take: 3,
              select: { content: true },
            });
            const recentEnvoyContents = recentEnvoy.map((m) => m.content);
            const echoResult = isEchoOfRecentEnvoy(message, recentEnvoyContents);
            echoFlag = echoResult.isEcho;

            const classified = await classifyChatIntent(message, {
              activeSessionsSummary: activeSessionsSummary || undefined,
              priorEnvoyTurn: recentEnvoyContents[0] ?? undefined,
              echoFlag,
            });
            intentBlock = classified.intent;
            classifierLatencyMs = classified.latencyMs;
            classifierRetried = classified.retried;
            rawClassifierKind = classified.rawKind;
            fabricationDetected = classified.fabricationDetected;
          }
          const intent = intentBlock.kind;

          // Structured telemetry at the dispatch seam (proposal §3.4).
          // userId + intent only — no utterance text, no PII beyond what
          // existing log lines already carry.
          console.log(
            JSON.stringify({
              event: "chat_intent",
              userId: safeUser.id,
              intent,
              rawKind: rawClassifierKind,
              hadClarifier: intent === "unclear" && !!intentBlock.clarifier,
              userIntentHintUsed: !!hintedIntent,
              classifierRetried,
              classifierLatencyMs,
              echoFlag,
              fabricationDetected,
            }),
          );

          // Tier dispatch — profile + rule short-circuit before the
          // calendar load and run against their own narrower playbook
          // via runDispatchHandler. Unclear also short-circuits below.
          if (intent === "profile" || intent === "rule") {
            const playbookRelativePath =
              intent === "profile"
                ? "src/agent/playbooks/profile.md"
                : "src/agent/playbooks/rule.md";
            let profileGapHints: string[] | undefined;
            if (intent === "profile") {
              try {
                const gaps = await computeProfileGaps(safeUser.id);
                profileGapHints = gaps.map((g) => g.hint);
              } catch (e) {
                console.warn(`[channel/chat] computeProfileGaps failed for ${safeUser.id}:`, e);
              }
            }
            try {
              await runDispatchHandler({
                tier: intent,
                playbookRelativePath,
                userId: safeUser.id,
                userName: user.name ?? null,
                channelId: safeChannel.id,
                userMessage: message,
                userMsgPersist,
                controller,
                encoder,
                profileGapHints,
                emitStatus: (stage) => {
                  emitStatus(stage);
                },
              });
            } catch (e) {
              console.error(`[channel/chat] dispatch-handler ${intent} failed:`, e);
            }
            controller.close();
            return;
          }

          if (intent === "chitchat") {
            const emoji = intentBlock.emoji ?? "👍";
            // Patch the host's message with the reaction emoji in-place, then
            // stream a reaction frame so the UI can render it immediately.
            const savedMsg = await userMsgPersist;
            await prisma.channelMessage.update({
              where: { id: savedMsg.id },
              data: {
                metadata: mergeChannelMetadata(savedMsg.metadata, { reaction: emoji }) as Prisma.InputJsonValue,
              },
            });
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ type: "reaction", emoji, messageId: savedMsg.id }) + "\n",
              ),
            );
            controller.close();
            return;
          }

          if (intent === "unclear") {
            await userMsgPersist;
            const clarifierText =
              intentBlock.clarifier ||
              "I'm not sure what you're asking — could you clarify?";
            const quickReplies = intentBlock.quickReplies ?? [];
            // Persist the clarifier as an envoy message. The stream frame
            // uses `type:"clarifier"` so the feed renders pill buttons;
            // the stored message keeps the text for history rendering
            // (stale clients without clarifier support still see the
            // question as a normal bubble — N8 degrade mode).
            await prisma.channelMessage.create({
              data: {
                channelId: safeChannel.id,
                role: "envoy",
                content: clarifierText,
                metadata: {
                  clarifier: { quickReplies },
                } as Prisma.InputJsonValue,
              },
            });
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "clarifier",
                  text: clarifierText,
                  quickReplies,
                }) + "\n",
              ),
            );
            controller.close();
            return;
          }

          // Schedule + inquire both need calendar context. Continue into
          // the existing load pipeline.
          const isInquireTier = intent === "inquire";

          // Stage 1: scanning-calendar — fires BEFORE parallel-group-2. The
          // group does more than just fetch schedule but the calendar read is
          // the dominant wait, so we anchor the frame here (§2.1 table).
          // Within-stage rotation ticks every WITHIN_STAGE_ROTATION_MS while
          // getOrComputeSchedule is in flight (proposal §2.2 R2 fold).
          const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
          const now = new Date();

          const [, sessionResult, scheduleResult, activeSessions] = await Promise.all([
            userMsgPersist,
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
              where: { hostId: safeUser.id, archived: false, status: { not: "cancelled" } },
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

            // Upcoming named events — lets Envoy resolve "cancel my meeting with
            // Katie" even when the NegotiationSession is old or below the take:20
            // limit. Only real events (with a summary) in the next 14 days.
            const upcomingLines = formatUpcomingEvents(scheduleResult.events, tz);
            if (upcomingLines) contextParts.push(upcomingLines);
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

          // Reusable links — General + all active office-hours rules — so the
          // inquire tier can answer recall questions ("what's my sales pitch link")
          // and the schedule tier can reference them. Per reusable-links proposal §4.
          {
            const explicitPrefs = (hostPrefs?.explicit as Record<string, unknown> | undefined) ?? {};
            const structuredRules =
              (explicitPrefs.structuredRules as Array<{
                action?: string;
                status?: string;
                officeHours?: { name?: string; title?: string; linkSlug?: string; linkCode?: string };
              }> | undefined) ?? [];
            const generalLinkName =
              typeof explicitPrefs.generalLinkName === "string" && explicitPrefs.generalLinkName.trim()
                ? explicitPrefs.generalLinkName
                : "General";
            const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || "https://agentenvoy.ai";
            const lines: string[] = [];
            if (safeUser.meetSlug) {
              lines.push(`- "${generalLinkName}" (default): ${origin}/meet/${safeUser.meetSlug}`);
            }
            for (const r of structuredRules) {
              if (r.action !== "office_hours" || r.status !== "active" || !r.officeHours) continue;
              const name = r.officeHours.name ?? r.officeHours.title ?? "Office Hours";
              const url = r.officeHours.linkSlug && r.officeHours.linkCode
                ? `${origin}/meet/${r.officeHours.linkSlug}/${r.officeHours.linkCode}`
                : "(url unavailable)";
              lines.push(`- "${name}": ${url}`);
            }
            if (lines.length > 0) {
              contextParts.push(
                `Host's reusable links (answer "what's my X link" / "share my X link" from this list — match by name fuzzy, case-insensitive; if the host asks generally for "my links" reply with the full list):\n${lines.join("\n")}`
              );
            }
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
              `Sessions (active and confirmed — "agreed" sessions have a confirmed calendar event and can be cancelled or rescheduled):\n${sessionList}\n\n` +
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

          // Inquire tier uses a narrower readonly playbook. §2.5 — runtime
          // playbook selection per dispatched tier. Proposal 3 will extend
          // this pattern (update_profile + rule handlers).
          const systemBase = isInquireTier ? INQUIRE_SYSTEM : CHANNEL_SYSTEM;
          const system = systemBase + "\n\nCONTEXT:\n" + contextParts.join("\n");
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

          // Skip the action-emission retry for inquire — the inquire
          // playbook forbids [ACTION] blocks by contract. A missing ACTION
          // block is expected, not a drift signal.
          if (!isInquireTier && needsActionEmissionRetry(fullText)) {
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
                systemPrompt: systemBase,
                contextBlock: contextParts.join("\n"),
                modelId,
              };
            }
            return mergeChannelMetadata(base ?? null, additions);
          };
          const finalizeResponse = async (text: string): Promise<string> => {
            try {
              const parsed = parseActions(text);
              // Inquire contract: no [ACTION] blocks allowed. Strip + log
              // if any slipped through — the playbook forbids them, but
              // defend against drift so we don't dispatch a create_link
              // during a readonly turn.
              if (isInquireTier && parsed.length > 0) {
                console.warn(
                  `[channel/chat] inquire tier emitted ${parsed.length} action block(s); stripping. userId=${safeUser.id}`,
                );
              }
              const actions = isInquireTier ? [] : parsed;
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
