import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { narrateFinalizeError } from "@/agent/action-narration";
import { sanitizeHistory } from "@/lib/conversation";
import {
  mergeChannelMetadata,
  parseChannelMessageMetadata,
} from "@/lib/channel/metadata-schema";
import {
  selectVariant,
  type ProgressStage,
  type ProgressExecutingAction,
  type ProgressCopyInterpolation,
} from "@/agent/progress-copy";
import { classifyChatIntent } from "@/agent/intent-classifier";
import { isEchoOfRecentEnvoy } from "@/lib/echo-detect";
import { normalizeChatIntent, type ChatIntentBlock } from "@/lib/intent";
// Import the modules registry side-effects (registers all dashboard-host
// modules: chat, rule, profile, create_bookable_link, inquire/query_*,
// create_link/modify_link/cancel_link/schedule).
import "@/agent/modules";
import { dispatchModuleAndStream } from "@/agent/modules/_shared/dispatch-stream";
import type { MatchResult } from "@/agent/modules/types";
import { evaluateFreshCreateGate } from "@/agent/classifiers/host-fresh-create-gate";
import {
  schedulingPrecheck,
  type PrecheckResult,
  type DeterministicCreateArgs,
} from "@/agent/matcher";
import { parseLinkParameters } from "@/lib/link-parameters";
import {
  shouldForceCalibrateFirstTime,
  CALIBRATE_FOLLOWTHROUGH_LOOKBACK,
} from "@/lib/onboarding/calibrate-followthrough-override";


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
    // PR-E (Q6 lock): cluster names are valid hint values ("event_action",
    // "inquire"). Type widened to string to accommodate cluster names that
    // are not in the ChatIntent union (they're cluster-level routing keys).
    const hintedIntent: string | null = (() => {
      if (typeof rawIntentHint !== "string") return null;
      const hint = rawIntentHint.trim();
      // Accept cluster-name hints directly (post-PR-E).
      if (hint === "event_action" || hint === "inquire") return hint;
      // Backward compat: old clients may still send "schedule" or a ChatIntent.
      const n = normalizeChatIntent(hint);
      if (n === "schedule") return "event_action"; // map legacy → cluster name
      if (n === "inquire") return "inquire";
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

        try {
          // Refresh-detection regex was load-bearing for the legacy schedule
          // path's `getOrComputeSchedule(safeUser.id, { forceRefresh })`
          // call; PR3b-iii moves that fetch into the schedule-context
          // loader, which always uses the cached path. Re-introducing
          // forceRefresh as a per-module hint is a follow-up.

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
            // hintedIntent is string | null (PR-E: cluster names like "event_action"
            // are not in the ChatIntent union but are valid routing keys here).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            intentBlock = { kind: hintedIntent as any };
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
          // ------------------------------------------------------------
          // Calibrate-followthrough dispatch override.
          //
          // Hotfix-1 (2026-05-05): introduced. Hotfix-2 (2026-05-05): broke
          // when seed-info became the most-recent envoy message and the
          // single-message predicate missed `calibrate-seed-info`.
          // Hotfix-3 (2026-05-05): widened to match either calibrate-* subkind
          // and to look across the most-recent N envoy messages. Once the
          // composer has responded once, its response is the most-recent
          // envoy turn and carries no calibrate-* subkind, so subsequent host
          // turns classify normally. 30-minute window stays as a backstop.
          //
          // Predicate lives in `@/lib/onboarding/calibrate-followthrough-override`
          // for testability.
          // ------------------------------------------------------------
          let forcedRoute: string | null = null;
          let forcedPlaybookVariant: string | null = null;
          {
            const recentEnvoy = await prisma.channelMessage.findMany({
              where: { channelId: safeChannel.id, role: "envoy" },
              orderBy: { createdAt: "desc" },
              take: CALIBRATE_FOLLOWTHROUGH_LOOKBACK,
              select: { metadata: true, createdAt: true },
            });
            if (shouldForceCalibrateFirstTime(recentEnvoy)) {
              forcedRoute = "calibrate-opener-followthrough";
              forcedPlaybookVariant = "first-time";
            }
          }

          // Apply the override before the dispatch chain. Telemetry logs
          // both `intent` (final routing) and `classifierIntent` (original)
          // so both are visible side-by-side when debugging.
          const classifierIntent = intentBlock.kind;
          const intent = forcedRoute === "calibrate-opener-followthrough"
            ? ("recalibrate" as typeof intentBlock.kind)
            : classifierIntent;

          // Structured telemetry at the dispatch seam (proposal §3.4).
          // userId + intent only — no utterance text, no PII beyond what
          // existing log lines already carry.
          console.log(
            JSON.stringify({
              event: "chat_intent",
              userId: safeUser.id,
              intent,
              classifierIntent,
              rawKind: rawClassifierKind,
              hadClarifier: intent === "unclear" && !!intentBlock.clarifier,
              userIntentHintUsed: !!hintedIntent,
              classifierRetried,
              classifierLatencyMs,
              echoFlag,
              fabricationDetected,
              forcedRoute,
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

          // recalibrate — PR-A onboarding module. Multi-field calibration retune.
          // Dispatched BEFORE the precheck block (no event-entity to resolve).
          // Pattern matches book_with_person's branch.
          if (intent === "recalibrate") {
            await dispatchModuleAndStream({
              surface: "dashboard-host",
              intent: "recalibrate",
              channelId: safeChannel.id,
              userId: safeUser.id,
              userName: user.name ?? null,
              userEmail: user.email ?? "",
              message,
              userMsgPersist,
              controller,
              encoder,
              emitStatus: (stage) => emitStatus(stage),
              matchResult: {
                kind: "deterministic",
                resolved: forcedRoute
                  ? { args: { forcedRoute } }
                  : {},
                ...(forcedPlaybookVariant
                  ? { playbookVariant: forcedPlaybookVariant }
                  : {}),
              },
            });
            controller.close();
            return;
          }

          // book_with_person — PR4 bookings module. Bilateral identity-resolve
          // + availability intersection + commit flow. Dispatched BEFORE the
          // precheck block (precheck only fires for event-shaping intents).
          // Pattern matches PR2's profile/rule branches.
          if (intent === "book_with_person") {
            await dispatchModuleAndStream({
              surface: "dashboard-host",
              intent: "book_with_person",
              channelId: safeChannel.id,
              userId: safeUser.id,
              userName: user.name ?? null,
              userEmail: user.email ?? "",
              message,
              userMsgPersist,
              controller,
              encoder,
              emitStatus: (stage) => emitStatus(stage),
              matchResult: {
                kind: "deterministic",
                resolved: {},
              },
            });
            controller.close();
            return;
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
            intent === "schedule" ||
            // PR-E: "event_action" cluster hint bypasses classifier and lands here.
            intent === "event_action";
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

          // PR3b-iii: the schedule-context loader (run inside runModule)
          // owns calendar load + active-sessions fetch + context-block
          // formatting. The route layer keeps just the channel-session
          // lifecycle (open/close/expire on a 3-day rolling window) plus
          // the userMsgPersist barrier — both inputs to the conversation-
          // history fetch below. Stage frame "scanning-calendar" fires here
          // anyway as a coarse progress signal; the loader does the actual
          // calendar read.
          const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
          const now = new Date();

          emitStatus("scanning-calendar");

          const [, sessionResult] = await Promise.all([
            userMsgPersist,
            prisma.channelSession.findFirst({
              where: { channelId: safeChannel.id, closed: false },
              orderBy: { startedAt: "desc" },
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

          // PR3b-iii: chat + event-shaped intents now dispatch via runModule.
          // The route layer's responsibilities for the schedule path are:
          //   (a) channel-session lifecycle (above — runs unconditionally)
          //   (b) precheck for event intents (above — multi-match early-returns)
          //   (c) build the conversation history from the 3-day rolling window
          //   (d) call dispatchModuleAndStream with the precheck hint folded
          //       into matchResult.resolved.args.precheckHint (modules' loader
          //       turns it into the system-prompt suffix). Inquire-tier and
          //       chat short-circuit earlier (PR3b-i / PR3b-ii) so reaching
          //       here means an event-shaped intent.
          const moduleIntent = intent;
          const matchResult: MatchResult = (() => {
            if (precheckResult?.kind === "deterministic-create") {
              return {
                kind: "deterministic" as const,
                resolved: {
                  freshCreate: true,
                  args: {
                    precheckHint: precheckCreateHint ?? undefined,
                    originatingIntent: moduleIntent,
                  },
                },
                playbookVariant: "deterministic-create",
              };
            }
            if (
              precheckResult?.kind === "deterministic-modify" ||
              precheckResult?.kind === "deterministic-cancel"
            ) {
              return {
                kind: "deterministic" as const,
                resolved: {
                  args: { originatingIntent: moduleIntent },
                },
                playbookVariant: precheckResult.kind,
              };
            }
            return {
              kind: "deterministic" as const,
              resolved: { args: { originatingIntent: moduleIntent } },
            };
          })();

          await dispatchModuleAndStream({
            surface: "dashboard-host",
            intent: moduleIntent,
            channelId: safeChannel.id,
            userId: safeUser.id,
            userName: user.name ?? null,
            userEmail: user.email ?? "",
            message,
            userMsgPersist,
            controller,
            encoder,
            emitStatus: (stage) => emitStatus(stage),
            conversationHistory: messages,
            matchResult,
            actionTimeoutMs: 15_000,
            narrateFailureResults: true,
            errorTag: `schedule:${moduleIntent}`,
          });

          // Silent-drift telemetry: matcher said deterministic but Sonnet
          // didn't emit the matching action. The runner's allowed-actions
          // enforcement strips out-of-bounds emissions; here we log the
          // case where the deterministic-expected action was simply absent
          // (likely Sonnet chose to clarify instead). Mirrors the legacy
          // path's `precheck_silent_drift` event for corpus segmentation.
          // (We log post-dispatch; the actual per-turn parsedActions are
          // already persisted on the envoy message metadata.)
          if (
            precheckResult?.kind === "deterministic-create" ||
            precheckResult?.kind === "deterministic-modify" ||
            precheckResult?.kind === "deterministic-cancel"
          ) {
            // The route no longer holds the parsedActions array. The
            // moduleGuard.bucket on the persisted envoy turn captures the
            // per-intent retry/guard signal; downstream telemetry can
            // join on (channelId, latest envoy turn) to reconstruct.
            // PR7 cleanup will revisit if the drift dashboard regresses.
          }

          controller.close();
          return;

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
