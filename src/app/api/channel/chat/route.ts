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
import {
  mergeChannelMetadata,
  parseChannelMessageMetadata,
} from "@/lib/channel/metadata-schema";
import type { ChannelMessageMetadata } from "@/lib/channel/metadata-schema";
import {
  needsActionEmissionRetry,
  needsActionShapeRetry,
  needsActionRedundancyRetry,
  ACTION_EMISSION_RETRY_PROMPT,
} from "@/agent/modules/_shared/post-stream-guards";
import type { SelfCheckRecord } from "@/lib/channel/metadata-schema";
import {
  selectVariant,
  type ProgressStage,
  type ProgressExecutingAction,
  type ProgressCopyInterpolation,
} from "@/agent/progress-copy";
import { runWithStageRotation } from "@/agent/progress-rotation";
import { classifyChatIntent } from "@/agent/intent-classifier";
import { isEchoOfRecentEnvoy } from "@/lib/echo-detect";
import { normalizeChatIntent, type ChatIntent, type ChatIntentBlock } from "@/lib/intent";
// Import the modules registry side-effects (registers chat smoke + rule +
// profile + create_bookable_link).
import "@/agent/modules";
import { dispatchModuleAndStream } from "@/agent/modules/_shared/dispatch-stream";
import { evaluateFreshCreateGate } from "@/agent/classifiers/host-fresh-create-gate";
import type { CalendarEvent } from "@/lib/calendar";
import {
  schedulingPrecheck,
  type PrecheckResult,
  type DeterministicCreateArgs,
} from "@/agent/matcher";
import { parseLinkParameters } from "@/lib/link-parameters";
import { voicePlaybook, calendarEventComposer } from "@/agent/runtime-prompts/index";

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

// Build system prompt bases via composition helper (PLAYBOOK Rule 19c).
// Called at request time (lazy) so playbook load failures surface per-request
// rather than killing module init.
function buildChannelSystem(): string {
  const persona = voicePlaybook();
  const channel = calendarEventComposer();
  return `${persona ? persona + "\n\n---\n\n" : ""}${channel}`;
}

// Profile + rule + create_bookable_link branches dispatch via runModule
// (PR2 — composer-modules architecture). Each module loads a narrower
// playbook and emits the shorter `thinking → executing → finalizing`
// taxonomy — no calendar scan or slot scoring.

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

          // ------------------------------------------------------------
          // Marco-pending replay (single-shot). Per the 2026-04-27
          // chat-decisioning-layer-redesign §11.4 Q2, when the previous
          // envoy turn fired a multi-match disambiguation, the *next*
          // host turn is parsed against the matched link IDs BEFORE
          // classification. Resolves Bug #5 ("new one" loop): the host
          // reply collapses straight to a deterministic action and we
          // clear the flag so it cannot replay forever.
          //
          // The flag is read off the most-recent envoy message's
          // `metadata.marcoPending`; persistence happens later in this
          // function when we write the disambiguation reply itself
          // (search for `MARCO_PENDING_PERSIST_SITE`).
          // ------------------------------------------------------------
          const lastEnvoyForMarco = await prisma.channelMessage.findFirst({
            where: { channelId: safeChannel.id, role: "envoy" },
            orderBy: { createdAt: "desc" },
            select: { id: true, metadata: true },
          });
          const marcoPendingState = (() => {
            if (!lastEnvoyForMarco?.metadata) return null;
            const parsed = parseChannelMessageMetadata(lastEnvoyForMarco.metadata);
            return parsed.marcoPending ?? null;
          })();
          let marcoReplayResolved: {
            kind: "create_link" | "modify_link" | "cancel_link";
            linkCode: string | null;
          } | null = null;
          if (marcoPendingState) {
            // Try to resolve the host's reply against the matched IDs.
            // Heuristic: explicit linkCode mention, or position words
            // ("first", "second", "the bike one", etc.) — keep narrow;
            // unparseable replies fall through to the classifier and the
            // flag is cleared regardless (single-shot).
            const lower = message.toLowerCase();
            const matched = marcoPendingState.matchedLinkIds.find((id) =>
              lower.includes(id.toLowerCase()),
            );
            // Direct match on a link code → resolve to the originating intent.
            if (matched) {
              marcoReplayResolved = {
                kind: marcoPendingState.originatingIntent,
                linkCode: matched,
              };
            } else if (
              /\b(new|another|fresh|different|new one|create|make a (new|second))\b/.test(
                lower,
              )
            ) {
              // "new one" / "create another" → defaults to create_link
              // regardless of what originated the marco. Resolves Bug #5.
              marcoReplayResolved = { kind: "create_link", linkCode: null };
            }
            // Clear the flag from the prior envoy row so it cannot replay,
            // even if marcoReplayResolved is null (unparseable → fall
            // through to classifier on this turn).
            try {
              await prisma.channelMessage.update({
                where: { id: lastEnvoyForMarco!.id },
                data: {
                  metadata: mergeChannelMetadata(lastEnvoyForMarco!.metadata, {
                    marcoPending: null,
                  }) as Prisma.InputJsonValue,
                },
              });
            } catch (e) {
              console.warn(
                `[channel/chat] failed to clear marcoPending flag for user ${safeUser.id}:`,
                e,
              );
            }
          }

          // Run classifier in parallel with the user-message persist
          // unless a quick-reply hint is present (then bypass entirely).
          let intentBlock: ChatIntentBlock;
          let classifierLatencyMs = 0;
          let classifierRetried = false;
          let rawClassifierKind: string | null = null;
          let fabricationDetected = false;
          let echoFlag = false;
          let recentEnvoyContents: string[] = [];
          if (marcoReplayResolved) {
            // Skip classifier entirely; trust the marco-pending reply.
            intentBlock = { kind: marcoReplayResolved.kind };
          } else if (hintedIntent) {
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
            recentEnvoyContents = recentEnvoy.map((m) => m.content);
            const echoResult = isEchoOfRecentEnvoy(message, recentEnvoyContents);
            echoFlag = echoResult.isEcho;

            // role: "host" is load-bearing — without it the classifier
            // defaults to "guest", loads the wrong playbook, and emits guest
            // intents (the root cause of Bugs #1, #2, #3 in the 2026-04-27
            // chat-decisioning-layer-redesign). PLAYBOOK Rule 19f makes
            // this argument mandatory via CI grep.
            const classified = await classifyChatIntent(
              message,
              {
                activeSessionsSummary: activeSessionsSummary || undefined,
                priorEnvoyTurn: recentEnvoyContents[0] ?? undefined,
                echoFlag,
              },
              "host",
            );
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
          // calendar load. Both run through `runModule` (PR2 — composer-
          // modules architecture). The route layer assembles the per-turn
          // context (user, channel, message) and delegates the lifecycle
          // (history sanitize → composer call → guards/retries → action
          // dispatch → metadata persist → stream) to dispatchModuleAndStream.
          if (intent === "profile") {
            await dispatchModuleAndStream({
              surface: "dashboard-host",
              intent: "profile",
              channelId: safeChannel.id,
              userId: safeUser.id,
              userName: user.name ?? null,
              userEmail: user.email ?? "",
              message,
              userMsgPersist,
              controller,
              encoder,
              emitStatus: (stage) => emitStatus(stage),
            });
            controller.close();
            return;
          }

          if (intent === "rule") {
            await dispatchModuleAndStream({
              surface: "dashboard-host",
              intent: "rule",
              channelId: safeChannel.id,
              userId: safeUser.id,
              userName: user.name ?? null,
              userEmail: user.email ?? "",
              message,
              userMsgPersist,
              controller,
              encoder,
              emitStatus: (stage) => emitStatus(stage),
              // Rule intent is mostly fresh-create at PR2; matcher refinement
              // (NLP rule-name resolution for "extend Sales pitch hours") is
              // future work. The rule module's fabricatedIdCheck handles
              // update vs add via [GROUND TRUTH] grounding.
              matchResult: {
                kind: "deterministic",
                resolved: { freshCreate: true },
                playbookVariant: "add",
              },
            });
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

          // ------------------------------------------------------------
          // Host-side dispatch (per 2026-04-27 chat-decisioning-layer-
          // redesign §2.2/§2.4). The host classifier emits one of seven
          // intents; the guest short-circuits above are no-ops for host
          // messages (host enum has no profile/rule/chitchat/unclear
          // values) but stay in place for `hintedIntent`-driven paths.
          // ------------------------------------------------------------

          // edit_preference → keyword-heuristic stopgap routing.
          // Open Question 1 of the composer-modules proposal (whether to
          // split at the classifier level into edit_profile/edit_rule)
          // remains open; PR2 preserves the legacy regex shape and routes
          // to either the profile or rule module accordingly. The
          // delegation lives at this route layer rather than inside a
          // standalone edit-preference module so each downstream module's
          // contextLoader / preEmitChecks / allowedActions stay tight.
          if (intent === "edit_preference") {
            const lowerMessage = message.toLowerCase();
            const isRuleShape =
              /\b(buffer|hours?|days?|am|pm|window|availability|protect|block|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening)\b/.test(
                lowerMessage,
              );
            const routedIntent: "profile" | "rule" = isRuleShape ? "rule" : "profile";
            await dispatchModuleAndStream({
              surface: "dashboard-host",
              intent: routedIntent,
              channelId: safeChannel.id,
              userId: safeUser.id,
              userName: user.name ?? null,
              userEmail: user.email ?? "",
              message,
              userMsgPersist,
              controller,
              encoder,
              emitStatus: (stage) => emitStatus(stage),
              errorTag: `edit_preference→${routedIntent}`,
              ...(isRuleShape
                ? {
                    matchResult: {
                      kind: "deterministic" as const,
                      resolved: { freshCreate: false },
                      playbookVariant: "update",
                    },
                  }
                : {}),
            });
            controller.close();
            return;
          }

          // chat → skip precheck entirely; fall straight through to the
          // composer with a free-form host system prompt. Bug #2
          // ("change to light mode") classifies here.
          //
          // query_calendar / query_event → reuse the inquire pipeline
          // (read-only, no [ACTION] blocks). Same pattern as today's
          // legacy "inquire" intent — set the tier flag and continue.
          //
          // create_link / modify_link / cancel_link → run the precheck
          // below, which may resolve to deterministic-create / -modify /
          // -cancel or fire multi-match-disambiguate.

          // Bookable link creation — dedicated intent routed directly to the
          // rule composer.
          //
          // historyLimit strategy:
          //   - Fresh create (no prior proposal in context): historyLimit:0 so the
          //     composer only sees the current message. This prevents prior bookable
          //     link sessions from contaminating the new request (e.g. "Setting up
          //     Candidate Screening" bleeding into "Create a tutoring link"). There
          //     is also a race condition: userMsgPersist may not have resolved when
          //     findMany runs, so take:4 could exclude the current message entirely.
          //   - Continuation (prior envoy turn was a proposal): historyLimit:4 so
          //     the composer can see what was proposed and what the user is tweaking.
          if (intent === "create_bookable_link") {
            // Fresh-create gate (F14 Phase 3.B): a continuation iff any of
            // the last 3 envoy turns mentions "bookable". Continuations get
            // historyLimit:4 (composer can see what was proposed and what
            // the host is tweaking); fresh creates get historyLimit:0 (no
            // bleed from a prior session, and immune to the userMsgPersist
            // race documented at chat/route.ts:702 pre-PR2).
            const gate = evaluateFreshCreateGate({ recentEnvoyContents });
            await dispatchModuleAndStream({
              surface: "dashboard-host",
              intent: "create_bookable_link",
              channelId: safeChannel.id,
              userId: safeUser.id,
              userName: user.name ?? null,
              userEmail: user.email ?? "",
              message,
              userMsgPersist,
              controller,
              encoder,
              emitStatus: (stage) => emitStatus(stage),
              historyLimit: gate.historyLimit,
              matchResult: {
                kind: "deterministic",
                resolved: { freshCreate: !gate.isContinuation },
                playbookVariant: "add",
              },
            });
            controller.close();
            return;
          }

          // Belt-and-suspenders: if the classifier returned create_link but
          // the message clearly describes a bookable link (keyword present),
          // re-route to the create-bookable-link module. This handles edge
          // cases where Haiku misclassifies due to prior Bobby/Katie context
          // in the channel.
          if (intent === "create_link") {
            const lowerMsg = message.toLowerCase();
            const isBookableCreate =
              /\b(bookable links?|office hours?|drop-?in hours?|booking window|mentor hours?|coaching hours?|open hours?|recurring (sessions?|link|bookable)|group meeting links?)\b/.test(lowerMsg);
            if (isBookableCreate) {
              await dispatchModuleAndStream({
                surface: "dashboard-host",
                intent: "create_bookable_link",
                channelId: safeChannel.id,
                userId: safeUser.id,
                userName: user.name ?? null,
                userEmail: user.email ?? "",
                message,
                userMsgPersist,
                controller,
                encoder,
                emitStatus: (stage) => emitStatus(stage),
                historyLimit: 0,
                errorTag: "create_link→bookable-fallback",
                matchResult: {
                  kind: "deterministic",
                  resolved: { freshCreate: true },
                  playbookVariant: "add",
                },
              });
              controller.close();
              return;
            }
          }

          // Schedule + inquire both need calendar context. The inquire-tier
          // branch (PR3b-i) dispatches via runModule before the precheck
          // block; precheck only fires for event-shaping intents.
          const isInquireTier =
            intent === "inquire" ||
            intent === "query_calendar" ||
            intent === "query_event";

          if (isInquireTier || intent === "chat") {
            // Inquire-tier (PR3b-i) + chat (PR3b-ii) modules: read-only or
            // free-form fall-through; no precheck, no channel-session
            // lifecycle (stays at the route layer for event-tier paths
            // until PR3b-iii). historyLimit:50 is a minor fidelity drop vs
            // the legacy 3-day-session-bounded window — defensible for
            // stateless read-only and conversational turns.
            await dispatchModuleAndStream({
              surface: "dashboard-host",
              intent,
              channelId: safeChannel.id,
              userId: safeUser.id,
              userName: user.name ?? null,
              userEmail: user.email ?? "",
              message,
              userMsgPersist,
              controller,
              encoder,
              emitStatus: (stage) => emitStatus(stage),
              historyLimit: 50,
              matchResult: {
                kind: "deterministic",
                resolved: {},
              },
            });
            controller.close();
            return;
          }

          // ------------------------------------------------------------
          // Deterministic scheduling precheck (PR-δ, §9.3.3).
          //
          // Fires only for `schedule`-tier turns. When we can resolve a
          // named guest from the message or recent thread, we either emit
          // a Marco-style disambiguation directly (skipping Sonnet) or
          // inject a strong system-prompt hint so Sonnet emits the
          // create_link action deterministically. Everything else falls
          // through to the existing pipeline.
          // ------------------------------------------------------------
          let precheckResult: PrecheckResult | null = null;
          let precheckCreateHint: string | null = null;
          // Tracks whether the multi-match-disambiguate branch has begun
          // emitting to the client. Once true, a thrown exception below
          // cannot be recovered by falling through to Sonnet (we'd
          // double-stream onto a half-closed response) — so we re-throw
          // and let the outer catch surface it as a user-visible error.
          // Pre-commit failures (Prisma blips, precheck-compute bugs)
          // degrade gracefully. Round-2 fix on PR #83 (2026-04-27).
          let precheckCommittedToClient = false;
          // Per the 2026-04-27 chat-decisioning-layer-redesign §2.2/§2.3,
          // the precheck fires for the three event-shaped host intents
          // plus the legacy "schedule" (which the guest endpoint still
          // emits). Intent values are passed through verbatim so the
          // matcher can branch on create-vs-modify-vs-cancel.
          const isEventIntent =
            intent === "create_link" ||
            intent === "modify_link" ||
            intent === "cancel_link" ||
            intent === "schedule";
          if (isEventIntent) {
            try {
              const [precheckSessions, recentTurns] = await Promise.all([
                prisma.negotiationSession.findMany({
                  where: { hostId: safeUser.id, archived: false },
                  include: {
                    link: { select: { inviteeName: true, code: true, parameters: true } },
                  },
                  orderBy: { updatedAt: "desc" },
                  take: 20,
                }),
                prisma.channelMessage.findMany({
                  where: { channelId: safeChannel.id },
                  orderBy: { createdAt: "desc" },
                  take: 10,
                  select: { role: true, content: true },
                }),
              ]);
              const mapped = precheckSessions.map((s) => {
                const params = s.link?.parameters
                  ? parseLinkParameters(s.link.parameters)
                  : null;
                return {
                  id: s.id,
                  title: s.title ?? null,
                  guestName: s.link?.inviteeName ?? null,
                  linkCode: s.link?.code ?? null,
                  status: s.status,
                  format: params?.format ?? null,
                  durationMinutes: params?.duration ?? null,
                  timingLabel: params?.timingLabel ?? null,
                  activity: params?.activity ?? null,
                };
              });
              precheckResult = schedulingPrecheck({
                classifiedIntent: intent as
                  | "create_link"
                  | "modify_link"
                  | "cancel_link"
                  | "schedule",
                userMessage: message,
                activeSessions: mapped,
                recentThreadTurns: recentTurns.slice().reverse(),
                // TODO: wire PR-β echo detector when it lands. Defaults to
                // false; does not change decisions.
                echoFlag: false,
              });

              console.log(
                JSON.stringify({
                  event: "scheduling_precheck",
                  userId: safeUser.id,
                  kind: precheckResult.kind,
                  classifiedIntent: intent,
                  reason: precheckResult.reason,
                  echoFlag: false,
                  namedGuest:
                    precheckResult.kind === "deterministic-create"
                      ? precheckResult.args.inviteeName
                      : null,
                  topic:
                    precheckResult.kind === "deterministic-create"
                      ? precheckResult.args.topic
                      : null,
                  duration:
                    precheckResult.kind === "deterministic-create"
                      ? precheckResult.args.duration
                      : null,
                  multiMatchCount:
                    precheckResult.kind === "multi-match-disambiguate"
                      ? precheckResult.matchedLinkIds.length
                      : null,
                  originatingIntent:
                    precheckResult.kind === "multi-match-disambiguate"
                      ? precheckResult.originatingIntent
                      : null,
                }),
              );

              // multi-match-disambiguate: skip Sonnet entirely, emit the
              // clarifier question directly. Persist `marcoPending` on the
              // envoy row so the next host turn replays into a deterministic
              // action (Bug #5 fix). MARCO_PENDING_PERSIST_SITE.
              if (precheckResult.kind === "multi-match-disambiguate") {
                await userMsgPersist;
                const matchedSessions = precheckResult.matchedSessions;
                const { originatingIntent, matchedLinkIds } = precheckResult;
                const list = matchedSessions
                  .map(
                    (m) =>
                      `- ${m.label} (${m.linkCode})`,
                  )
                  .join("\n");
                // Post-2026-04-30: matcher only routes here for modify_link
                // / cancel_link (create_link trusts the classifier and goes
                // straight to deterministic-create). The prompt always
                // offers a "create new" escape hatch in case the user
                // actually meant a fresh link.
                const text =
                  originatingIntent === "cancel_link"
                    ? `I see similar meetings — which one did you want to cancel?\n${list}`
                    : `I see similar meetings, including these:\n${list}\n\nDid you want to change one of them, or create a new one?`;
                await prisma.channelMessage.create({
                  data: {
                    channelId: safeChannel.id,
                    role: "envoy",
                    content: text,
                    metadata: {
                      marcoPending: {
                        matchedLinkIds,
                        originatingIntent,
                      },
                    } as Prisma.InputJsonValue,
                  },
                });
                precheckCommittedToClient = true;
                controller.enqueue(
                  encoder.encode(
                    JSON.stringify({ type: "text", content: text }) + "\n",
                  ),
                );
                controller.close();
                return;
              }

              // Deterministic-create: use the injected-hint path (proposal
              // alternative in §9.3.3). We bias Sonnet's system prompt with
              // a required-ACTION directive; the existing action-emission
              // guard retries if the model drops the block. This avoids
              // rearchitecting the stream pipeline to emit actions server-
              // side — documented choice (PR description).
              if (precheckResult.kind === "deterministic-create") {
                precheckCreateHint = buildDeterministicCreateHint(precheckResult.args);
              }
              // deterministic-modify / deterministic-cancel — for PR1 we
              // fall through to Sonnet without an injected hint. The
              // composer has full session/link context already; the
              // matcher's job here was deciding "yes this is a real
              // modify/cancel against a single existing link" (vs the
              // multi-match case that fired marco above). PR3 may add
              // a -modify / -cancel injected-hint path when the dealroom
              // composer split lands and we want deterministic action
              // emission for these too.
            } catch (precheckErr) {
              if (precheckCommittedToClient) {
                throw precheckErr;
              }
              const err =
                precheckErr instanceof Error
                  ? precheckErr
                  : new Error(String(precheckErr));
              console.error(
                JSON.stringify({
                  event: "scheduling_precheck_failed",
                  userId: safeUser.id,
                  errName: err.name,
                  errMessage: err.message,
                  stack: err.stack,
                }),
              );
              precheckResult = null;
              precheckCreateHint = null;
              // Fall through to the Sonnet pipeline below.
            }
          }

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

          // Reusable links — Primary + all active Bookable Link rules — so the
          // inquire tier can answer recall questions ("what's my sales pitch link")
          // and the schedule tier can reference them. Per reusable-links proposal §4.
          {
            const explicitPrefs = (hostPrefs?.explicit as Record<string, unknown> | undefined) ?? {};
            const structuredRules =
              (explicitPrefs.structuredRules as Array<{
                action?: string;
                status?: string;
                bookable?: { name?: string; title?: string; linkSlug?: string; linkCode?: string };
              }> | undefined) ?? [];
            const primaryLinkName =
              typeof explicitPrefs.primaryLinkName === "string" && (explicitPrefs.primaryLinkName as string).trim()
                ? explicitPrefs.primaryLinkName as string
                : "Primary link";
            const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || "https://agentenvoy.ai";
            const lines: string[] = [];
            if (safeUser.meetSlug) {
              lines.push(`- "${primaryLinkName}" (default): ${origin}/meet/${safeUser.meetSlug}`);
            }
            for (const r of structuredRules) {
              if (r.action !== "bookable" || r.status !== "active") continue;
              const linkData = r.bookable;
              if (!linkData) continue;
              const name = linkData.name ?? linkData.title ?? "Drop-in Hours";
              const url = linkData.linkSlug && linkData.linkCode
                ? `${origin}/meet/${linkData.linkSlug}/${linkData.linkCode}`
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

          // Inquire-tier short-circuits at line 677 (PR3b-i). Reaching here
          // means this is a chat or event-shaped intent on the legacy
          // schedule path; both use the channel composer.
          const systemBase = buildChannelSystem();
          const precheckHintBlock = precheckCreateHint
            ? "\n\n" + precheckCreateHint
            : "";
          const system =
            systemBase + precheckHintBlock + "\n\nCONTEXT:\n" + contextParts.join("\n");
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

          // selfCheck record — written to message metadata if either guard
          // fires. Read by future eval rig (proposal §2 Layer 4).
          let selfCheckRecord: SelfCheckRecord | null = null;

          // Inquire-tier short-circuits earlier (PR3b-i). Reaching here means
          // this is a chat or event-shaped intent; run the action-fidelity
          // guards.
          {
            // Layer 2a — existing emission guard (no [ACTION] block at all).
            const emissionFired = needsActionEmissionRetry(fullText);
            // Parse actions once so the shape + redundancy checks can both
            // inspect them without re-parsing.
            const parsedActions = !emissionFired ? parseActions(fullText) : [];
            // Layer 2b — new shape guard (action emitted but missing
            // guestPicks key required by prose). Only runs when emission
            // guard didn't fire — emission's [ACTION]-present short-circuit
            // is what enables shape to inspect actions, but if no [ACTION]
            // is present at all the shape check has nothing to inspect.
            const shapeFired = !emissionFired
              ? needsActionShapeRetry(fullText, parsedActions)
              : null;
            // F6 (2026-05-01) — false-apology / duplicate-re-emit guard.
            // Detects composer prose claiming a prior action didn't fire
            // (when in fact it did) followed by a redundant re-emit. Runs
            // only when an action was emitted; otherwise emission guard
            // already covers the no-emit case.
            const redundancyFired =
              !emissionFired && !shapeFired
                ? needsActionRedundancyRetry(fullText, parsedActions)
                : null;

            if (emissionFired || shapeFired || redundancyFired) {
              const flaggedReason =
                shapeFired?.flaggedReason ??
                redundancyFired?.flaggedReason ??
                "set-up-x";
              const retryHint =
                shapeFired?.hint ??
                redundancyFired?.hint ??
                ACTION_EMISSION_RETRY_PROMPT;
              console.warn(
                `[channel/chat] action-fidelity guard fired (${flaggedReason}) for user ${safeUser.id}, forcing retry`
              );
              const originalText = fullText;
              selfCheckRecord = {
                flaggedReason,
                retryAttempted: true,
                retrySucceeded: null,
                originalText,
              };
              // Emit retry frame (capped at 2 per turn).
              emitStatus("retrying");
              const retry = await generateText({
                model: envoyModel(modelId),
                maxOutputTokens: 512,
                system,
                messages: [
                  ...messages,
                  { role: "assistant", content: fullText },
                  { role: "user", content: retryHint },
                ],
              });
              if (retry.text.trim()) {
                fullText += "\n\n" + retry.text;
                // Retry succeeded if it added any content. We don't try to
                // judge whether the retry's content actually fixed the
                // problem here — Layer 4 corpus + offline eval analyze that.
                selfCheckRecord = {
                  ...selfCheckRecord,
                  retrySucceeded: true,
                  correctedText: fullText,
                };
              } else {
                selfCheckRecord = { ...selfCheckRecord, retrySucceeded: false };
              }
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
            if (selfCheckRecord) {
              additions.selfCheck = selfCheckRecord;
            }
            return mergeChannelMetadata(base ?? null, additions);
          };
          const finalizeResponse = async (text: string): Promise<string> => {
            try {
              const parsed = parseActions(text);
              // Inquire-tier short-circuits earlier (PR3b-i); the runner's
              // allowed-actions enforcement strips any [ACTION] blocks for
              // those intents. Reaching here means chat or event-shaped.
              // Silent-drift telemetry (Round-2 fix on PR #83, 2026-04-27;
              // extended for PR1 of the chat-decisioning-layer-redesign).
              // The matcher has decided this turn is a deterministic
              // create / modify / cancel against an existing entity, but
              // Sonnet emerged with no matching action — likely Sonnet
              // chose to clarify instead. Per §11.5 P5 the event keeps
              // firing across the new intent split with the same name,
              // and adds an `originatingIntent` field while keeping the
              // old field shapes during the 7-day grace period.
              if (
                precheckResult?.kind === "deterministic-create" ||
                precheckResult?.kind === "deterministic-modify" ||
                precheckResult?.kind === "deterministic-cancel"
              ) {
                const expectedAction =
                  precheckResult.kind === "deterministic-create"
                    ? "create_link"
                    : precheckResult.kind === "deterministic-modify"
                      ? "update_link"
                      : "cancel";
                const emittedExpected = parsed.some(
                  (a) => a.action === expectedAction,
                );
                if (!emittedExpected) {
                  const originatingIntent =
                    precheckResult.kind === "deterministic-create"
                      ? "create_link"
                      : precheckResult.kind === "deterministic-modify"
                        ? "modify_link"
                        : "cancel_link";
                  console.log(
                    JSON.stringify({
                      event: "precheck_silent_drift",
                      userId: safeUser.id,
                      // New PR1 field — `originatingIntent` lets the
                      // dashboard split create vs modify vs cancel rates.
                      originatingIntent,
                      // Old fields kept for 7-day grace per §11.5 P5;
                      // only populated when the precheck was a create
                      // (-modify / -cancel never carried these).
                      inviteeName:
                        precheckResult.kind === "deterministic-create"
                          ? precheckResult.args.inviteeName
                          : null,
                      topic:
                        precheckResult.kind === "deterministic-create"
                          ? precheckResult.args.topic
                          : null,
                      duration:
                        precheckResult.kind === "deterministic-create"
                          ? precheckResult.args.duration
                          : null,
                      dateRangeKeyword:
                        precheckResult.kind === "deterministic-create"
                          ? precheckResult.args.dateRangeKeyword
                          : null,
                      emittedActions: parsed.map((a) => a.action),
                      responseSample: text.slice(0, 200),
                    }),
                  );
                }
              }
              const actions = parsed;
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
                  actionResults.filter((r) => !r.silent).length > 0
                    ? actionResults
                        .filter((r) => !r.silent)
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

              const visibleResults = actionResults.filter((r) => !r.silent);
              if (visibleResults.length > 0) {
                const summary = visibleResults
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

/**
 * Build an injected-hint prompt block for `deterministic-create` precheck
 * results. Per proposal §9.3.3, when the precheck resolves a named guest
 * with no active link, we bias Sonnet's system prompt to emit the
 * create_link ACTION with the pre-extracted args; the model only has to
 * write the 1-2-sentence confirmation bubble.
 *
 * We pass the hint rather than emitting the action server-side so we avoid
 * rearchitecting the stream pipeline. The existing action-emission guard
 * will retry if Sonnet drops the ACTION block.
 */
function buildDeterministicCreateHint(args: DeterministicCreateArgs): string {
  const params: Record<string, unknown> = {
    inviteeName: args.inviteeName,
  };
  if (args.topic) params.topic = args.topic;
  if (args.duration) params.durationMinutes = args.duration;
  if (args.dateRangeKeyword) params.dateRangeKeyword = args.dateRangeKeyword;
  const actionBlock = `[ACTION]${JSON.stringify({
    action: "create_link",
    params,
  })}[/ACTION]`;
  return (
    `[DETERMINISTIC PRECHECK]\n` +
    `A deterministic precheck has resolved this turn as a new-link request for ` +
    `guest "${args.inviteeName}". Emit EXACTLY this action block and follow it ` +
    `with a 1-2 sentence confirmation bubble. Do not ask clarifying questions; ` +
    `the guest is resolved.\n` +
    `Required action:\n${actionBlock}\n`
  );
}
