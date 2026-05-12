/**
 * Deal-room context loader (Phase A.4).
 *
 * Builds the per-turn context for a deal-room unified-agent run. Returns
 * everything `runUnifiedTurn` needs: sanitized history, GROUND TRUTH lines
 * (dual-tz, [LOCKED] negotiated values, sessionLiveEvent), and the
 * tier-selection signals (priorToolUseInHistory, priorEnvoyTurnCount,
 * priorEnvoyTurnAgeMs).
 *
 * Mirrors the loader concerns in `negotiate/message/route.ts:146-311`
 * (history sanitization, GROUND TRUTH injection, dual-tz, sessionLiveEvent)
 * but produces a structured output the runner can compose without route
 * coupling.
 *
 * Group-coordination context is deferred to a follow-up — group sessions
 * are out of scope for v1 deal-room migration per proposal §2.7(f).
 *
 * Refs:
 *   - proposals/2026-05-11_complete-unified-agent-migration-and-retire-classifier-composer_reviewed-2026-05-11_decided-2026-05-11.md §2.7 + §3.2
 *   - handoffs/_phase-a-implementation-plan_2026-05-11.md §3 (five surviving behaviors) + §4 (post-stream pipeline)
 *   - proposals/2026-04-21_deal-room-calendar-primary-and-slot-tiering-reshape (dual-tz "non-negotiable")
 *   - proposals/2026-04-22_guest-activity-location-negotiation (LOCKED semantics)
 *   - proposals/2026-05-04_update-time-action-state-drift (F2/F15 sessionLiveEvent)
 */

import { prisma } from "@/lib/prisma";
import { parseGuestTimeReferences, renderParsedTime } from "@/lib/time-parse";
import type { UnifiedHistoryMessage } from "@/agent/unified/runner";

/**
 * Role of the human speaking on this turn. Determines:
 *   - Which dealroom-unified.md `{{ROLE}}` substitution applies.
 *   - Whether dual-tz parsing applies to the speaker's text (guest-only).
 *   - Tool subset via `buildUnifiedToolsFor`.
 *   - Persistence's `actor.triggeringRole` audit value.
 */
export type DealroomSpeakerRole = "host" | "guest";

export type DealroomContextInput = {
  sessionId: string;
  /** Role of the human typing this turn. Derived by the route from NextAuth
   *  vs. session ownership: `auth.userId === session.hostId ? "host" : "guest"`. */
  speakerRole: DealroomSpeakerRole;
  /** Current message text. Used by dual-tz parser when active and by
   *  the runner's grounding-check pass-through. */
  currentMessage: string;
};

export type DealroomContext = {
  /** Sanitized history ready for AI SDK — administrator → assistant rewrite,
   *  system rows dropped. */
  history: UnifiedHistoryMessage[];
  /** GROUND TRUTH lines prepended to the system prompt at request time.
   *  Each entry is a bracketed line e.g. `[GROUND TRUTH] Dual-tz mode active...`. */
  groundTruthLines: string[];
  /** Session metadata the runner threads into the persistence callback. */
  session: {
    id: string;
    hostId: string;
    hostTimezone: string;
    /** Viewer-authoritative tz from the session row when dual-tz is active;
     *  matches handoff §3.3 (the "non-negotiable" 2026-04-21 rule). */
    viewerTimezone: string | null;
    /** Used to label `actor.triggeringRole` on the persistence write path. */
    speakerRole: DealroomSpeakerRole;
    /** Most-recent envoy turn's age in ms — feeds the recency-window gate. */
    priorEnvoyTurnAgeMs?: number;
    priorEnvoyTurnCount: number;
    priorToolUseInHistory: boolean;
    /** History was trimmed to empty because the prior envoy turn was older
     *  than `STALE_HISTORY_THRESHOLD_MS` (10 min). Mirrors the host-channel
     *  loader; persisted to `metadata.unifiedTurn.historyTrimmedForStaleness`
     *  by the runner. Closes the F14 cross-thread bleed family. */
    historyTrimmedForStaleness: boolean;
  };
};

/**
 * Mirrors `STALE_HISTORY_THRESHOLD_MS` in `runner.ts`. Kept as a separate
 * constant here (not imported) so deal-room and host-channel can be tuned
 * independently if their stale-context characteristics diverge — both
 * default to 10 min per John's 2026-05-12 prescription.
 */
const STALE_HISTORY_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Progressive context loading (mirrors `FRESH_HISTORY_PRELOAD_TURNS` in
 * runner.ts). When fresh, preload only the most recent envoy turn + its
 * immediately preceding user turn. The model calls `LOAD_recent_history`
 * to fetch more on demand. Closes the F14 cross-thread bleed family.
 */
const FRESH_HISTORY_PRELOAD_TURNS = 2;

/**
 * Load + assemble the deal-room turn's context.
 *
 * Hits Prisma three times:
 *   1. NegotiationSession + link + host (single query)
 *   2. Recent Messages for the session (one query)
 *
 * Returns a sanitized, structured context the runner can compose into a
 * UnifiedTurnConfig without further DB hits.
 *
 * Throws if the session is not found — route should handle 404 upstream.
 */
export async function loadDealroomContext(
  input: DealroomContextInput,
): Promise<DealroomContext> {
  const session = await prisma.negotiationSession.findUnique({
    where: { id: input.sessionId },
    include: {
      link: {
        select: {
          inviteeName: true,
          parameters: true,
        },
      },
      host: {
        select: {
          id: true,
          preferences: true,
        },
      },
    },
  });
  if (!session) {
    throw new Error(`Deal-room context: session not found (id=${input.sessionId})`);
  }

  // Resolve timezones.
  const hostPrefs = (session.host.preferences as Record<string, unknown> | null) ?? {};
  const hostTimezone =
    (hostPrefs.timezone as string | undefined) ?? "America/Los_Angeles";
  // Viewer tz: written to the session row by the deal-room first-render path
  // (per the 2026-04-21 "non-negotiable" guest-tz primitives proposal).
  const viewerTimezone =
    (session as unknown as { viewerTimezone?: string | null }).viewerTimezone ?? null;
  const dualTzActive =
    viewerTimezone !== null && viewerTimezone !== hostTimezone;

  // Load recent history. Window matches the host-channel UA (10 turns).
  // Cap is the same regardless of side because the AI SDK budget doesn't
  // care about which DB the rows came from.
  const rows = await prisma.message.findMany({
    where: { sessionId: input.sessionId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { role: true, content: true, createdAt: true, metadata: true },
  });

  // Tier-selection signals (mirrors loadRecentHistory in runner.ts).
  const mostRecentEnvoy = rows.find((r) => r.role === "administrator");
  const priorEnvoyTurnAgeMs = mostRecentEnvoy
    ? Date.now() - mostRecentEnvoy.createdAt.getTime()
    : undefined;
  const priorEnvoyTurnCount = rows.filter((r) => r.role === "administrator").length;
  const priorToolUseInHistoryRaw = rows.some((r) => {
    if (r.role !== "administrator") return false;
    const md = r.metadata as { unifiedTurn?: { toolCalls?: string[] } } | null;
    return Array.isArray(md?.unifiedTurn?.toolCalls) && md.unifiedTurn.toolCalls.length > 0;
  });

  // Stale-history trim (mirrors runner.ts). When the prior envoy turn is
  // older than STALE_HISTORY_THRESHOLD_MS, drop history entirely — the model
  // sees only the current user turn. Closes the F14 cross-thread bleed
  // family for deal-room sessions just as it does for the host-channel.
  const historyTrimmedForStaleness =
    typeof priorEnvoyTurnAgeMs === "number" &&
    priorEnvoyTurnAgeMs > STALE_HISTORY_THRESHOLD_MS;

  // History sanitization per `negotiate/message/route.ts:146-154` shape.
  // administrator → assistant; system rows dropped; oldest-first.
  // Progressive preload: when fresh, take only FRESH_HISTORY_PRELOAD_TURNS
  // (last administrator + preceding human). When stale, drop entirely.
  // Filter happens BEFORE the slice so system rows in the window don't push
  // a real turn pair out of the preload.
  const history: UnifiedHistoryMessage[] = historyTrimmedForStaleness
    ? []
    : rows
        .filter((r) => r.role === "administrator" || r.role === "guest" || r.role === "host")
        .slice(0, FRESH_HISTORY_PRELOAD_TURNS) // rows are desc — take newest N
        .reverse()
        .map((r) => ({
          role: r.role === "administrator" ? ("assistant" as const) : ("user" as const),
          content: r.content,
        }));
  // When history is trimmed, the model isn't actually seeing those tool
  // calls — keeping priorToolUseInHistory true would lie to the tier router
  // (which would keep Sonnet for an already-fresh channel).
  const priorToolUseInHistory = historyTrimmedForStaleness
    ? false
    : priorToolUseInHistoryRaw;

  // Compose GROUND TRUTH lines. Order matters — earlier lines anchor higher
  // in the system prompt by convention; `[SESSION_ID]` is always first so
  // the model never reaches for a fabricated session id.
  const groundTruthLines: string[] = [];
  groundTruthLines.push(`[SESSION_ID] ${input.sessionId}`);
  groundTruthLines.push(`[HOST_TZ] ${hostTimezone}`);
  if (viewerTimezone) {
    groundTruthLines.push(`[VIEWER_TZ] ${viewerTimezone}`);
  }

  // [LOCKED] values from the 2026-04-22 guest-activity-location-negotiation
  // decision. Stored on link.parameters as negotiated*. Already-confirmed
  // values must NOT be re-opened in the prompt.
  const linkParams = (session.link.parameters as Record<string, unknown> | null) ?? {};
  const negotiated = (linkParams.negotiated as Record<string, unknown> | undefined) ?? {};
  if (typeof negotiated.activity === "string") {
    groundTruthLines.push(`[LOCKED] Activity: ${negotiated.activity}`);
  }
  if (typeof negotiated.location === "string") {
    groundTruthLines.push(`[LOCKED] Location: ${negotiated.location}`);
  }
  if (typeof negotiated.format === "string") {
    groundTruthLines.push(`[LOCKED] Format: ${negotiated.format}`);
  }

  // F2/F15 sessionLiveEvent — when the session is `agreed` with a live GCal
  // event, signal so the model treats follow-up turns as re-times of a
  // confirmed meeting (not fresh negotiation). Mirrors `negotiate/message/route.ts:303-311`.
  if (session.status === "agreed" && session.calendarEventId) {
    const agreedTime = session.agreedTime ? session.agreedTime.toISOString() : null;
    groundTruthLines.push(
      `[SESSION_LIVE_EVENT] calendarEventId=${session.calendarEventId}` +
        (agreedTime ? ` priorAgreedTime=${agreedTime}` : ""),
    );
  }

  // Dual-tz parsed time references — deterministic regex parser, NOT LLM.
  // Only applies to GUEST turns (per handoff §3.3). The host never has bare
  // times to reinterpret; their messages are authored in their own tz.
  if (dualTzActive && input.speakerRole === "guest" && viewerTimezone) {
    const refs = parseGuestTimeReferences(input.currentMessage, viewerTimezone);
    if (refs.length > 0) {
      groundTruthLines.push(`[PARSED_TIMES] Deterministic parser output (use these — do not re-interpret):`);
      for (const ref of refs) {
        const rendered = renderParsedTime(ref);
        if (ref.ambiguous || !rendered) {
          groundTruthLines.push(`  - "${ref.raw}" — AMBIGUOUS — ask the guest to clarify; default to viewer tz (${viewerTimezone}).`);
        } else {
          groundTruthLines.push(`  - "${ref.raw}" → ${rendered} in viewer tz (${viewerTimezone}). Echo both viewer + host tz in the confirmation.`);
        }
      }
    }
  }

  return {
    history,
    groundTruthLines,
    session: {
      id: session.id,
      hostId: session.host.id,
      hostTimezone,
      viewerTimezone,
      speakerRole: input.speakerRole,
      priorEnvoyTurnAgeMs,
      priorEnvoyTurnCount,
      priorToolUseInHistory,
      historyTrimmedForStaleness,
    },
  };
}
