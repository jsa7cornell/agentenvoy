/**
 * Dormant-return eligibility + onboarding-state aggregation helpers.
 *
 * Two surfaces live here:
 *
 *  1. `tuningInProgress(messages)` — the Q3 guard introduced in PR-E of the
 *     prior onboarding proposal. Suppresses <DormantReturnBubble> when an
 *     auto-resumed PrimaryLinkFlow is in flight.
 *
 *  2. `computeOnboardingState(...)` + supporting helpers — the
 *     post-conversational-onboarding aggregation introduced in PR-C of
 *     `2026-05-05_conversational-onboarding-vision`. Per Author Response N5
 *     (the Q7 flip): this aggregation EXTENDS this file rather than living
 *     in a parallel `lib/onboarding/state.ts`. Single file, more functions —
 *     mirrors ONBOARD §5 R1 single-source-of-truth discipline.
 *
 * Uses the messages-as-state-of-record invariant (per 2026-04-30 proposal):
 * the in-progress / terminal state of any flow is read from ChannelMessage
 * metadata rather than a separate DB column.
 */
import { prisma } from "@/lib/prisma";

/** Minimal shape of a ChannelMessage needed for flow detection. */
export interface MessageMetaSlice {
  metadata?: Record<string, unknown> | null;
}

/**
 * Extended message slice with createdAt — needed by `computeOnboardingState`
 * to derive `daysSinceLastChannelMessage` and the most-recent terminal-marker
 * timestamps.
 */
export interface DatedMessageMetaSlice extends MessageMetaSlice {
  createdAt: Date | string;
}

/**
 * Returns true when a PrimaryLinkFlow or preferences-extended flow appears to
 * be in progress in the given message list — meaning the dormant bubble
 * should be suppressed.
 *
 * Logic:
 *  - Walk messages looking for any with `kind === "onboarding"` and
 *    `subkind === "primary-link-tuning"` or `subkind === "preferences-extended"`.
 *  - If found, check whether a terminal message (same subkind + `terminal: true`)
 *    also exists. If no terminal message: flow is still in progress → returns true.
 *  - If both flows are absent or both have terminal markers → returns false.
 */
export function tuningInProgress(messages: MessageMetaSlice[]): boolean {
  const hasTuning = messages.some((m) => {
    const meta = m.metadata;
    return meta?.kind === "onboarding" && meta?.subkind === "primary-link-tuning";
  });

  if (hasTuning) {
    const tuningDone = messages.some((m) => {
      const meta = m.metadata;
      return meta?.subkind === "primary-link-tuning" && meta?.terminal === true;
    });
    if (!tuningDone) return true;
  }

  const hasExtended = messages.some((m) => {
    const meta = m.metadata;
    return meta?.kind === "onboarding" && meta?.subkind === "preferences-extended";
  });

  if (hasExtended) {
    const extendedDone = messages.some((m) => {
      const meta = m.metadata;
      return meta?.subkind === "preferences-extended" && meta?.terminal === true;
    });
    if (!extendedDone) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// PR-C: OnboardingState aggregation
//
// Per `2026-05-05_conversational-onboarding-vision` §3.3 + Author Response N5
// (the Q7 flip). Pure aggregation of (a) `user.lastCalibratedAt` from prisma
// + the counts that drive welcome-variant resolution, and (b) ChannelMessage
// rows scanned for terminal markers. Modules consume this via the shared
// schedule-context loader (`onboardingState?: OnboardingState`).
//
// `lastCalibrationCompletionAt` is split from `lastTuningCompletionAt` so
// the chat module's `post-calibration` variant can fire within 5 minutes of
// recalibrate-arc completion specifically — distinct from the legacy
// deterministic PrimaryLinkFlow's `primary-link-tuning` terminal marker
// (the auto-resume legacy path).
// ---------------------------------------------------------------------------

/**
 * Welcome-variant matrix. Mirrors the resolution at
 * `app/src/app/api/me/scheduling-defaults/route.ts:160-184`.
 */
export type WelcomeVariant =
  | "first-run"
  | "guest-first"
  | "returning-dormant"
  | "active";

/** 14d cutoff for `returning-dormant`. Mirrors scheduling-defaults route. */
export const RETURNING_DORMANT_THRESHOLD_DAYS = 14;

/**
 * Aggregated onboarding state for prompt-time consumption.
 *
 * Per Author Response N1: speculative shapes (`seededFields`,
 * `capabilitiesNotYetIntroduced`, `bookableLinksOwnedCount`) were dropped
 * from v1. This shape carries only fields the chat / recalibrate cluster
 * variants actually branch on.
 */
export interface OnboardingState {
  welcomeVariant: WelcomeVariant;
  /** Days since `user.lastCalibratedAt`; null when never calibrated. */
  daysSinceCalibration: number | null;
  /** Days since the most-recent ChannelMessage (any role); null when none. */
  daysSinceLastChannelMessage: number | null;
  /** True when a `subkind: "primary-link-tuning", terminal: true` row exists. */
  primaryLinkTuningCompleted: boolean;
  /** True when a `subkind: "preferences-extended", terminal: true` row exists. */
  preferencesExtendedCompleted: boolean;
  /** Most-recent `primary-link-tuning` terminal-row timestamp, or null. */
  lastTuningCompletionAt: Date | null;
  /**
   * Most-recent `recalibrate` terminal-row timestamp, or null. Distinct from
   * `lastTuningCompletionAt` so the chat `post-calibration` variant can fire
   * on recalibrate-arc completion specifically (5-minute window).
   */
  lastCalibrationCompletionAt: Date | null;
  /** Count of profile gaps active this turn (passed in from the loader). */
  profileGapsCount: number;
}

/** Coerce a Date | string into a Date for arithmetic. */
function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * Find the most-recent ChannelMessage matching `(kind: "onboarding",
 * subkind: <subkind>, terminal: true)`. Returns the row's createdAt or null.
 */
export function findLatestTerminalMarkerAt(
  messages: DatedMessageMetaSlice[],
  subkind: "primary-link-tuning" | "preferences-extended" | "recalibrate",
): Date | null {
  let latest: Date | null = null;
  for (const m of messages) {
    const meta = m.metadata;
    if (
      meta?.kind === "onboarding" &&
      meta?.subkind === subkind &&
      meta?.terminal === true
    ) {
      const at = toDate(m.createdAt);
      if (!latest || at.getTime() > latest.getTime()) latest = at;
    }
  }
  return latest;
}

/** Days (floor) between `from` and `now`. */
function daysBetween(from: Date, now: Date): number {
  return Math.floor((now.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Resolve `welcomeVariant` server-side from the same inputs the
 * `/api/me/scheduling-defaults` route uses (lines 87-184). Pure; no I/O.
 *
 * The route's `messageCount` is the channel's all-roles message count, not
 * host-only — kept identical here so prompt-time reads match the client
 * greeting card.
 */
export function resolveWelcomeVariant(args: {
  messageCount: number;
  lastChannelMessageAt: Date | null;
  hostedSessionCount: number;
  guestSessionCount: number;
  participantCount: number;
  now: Date;
}): WelcomeVariant {
  const {
    messageCount,
    lastChannelMessageAt,
    hostedSessionCount,
    guestSessionCount,
    participantCount,
    now,
  } = args;
  if (messageCount > 0) {
    const daysSince = lastChannelMessageAt
      ? (now.getTime() - lastChannelMessageAt.getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    return daysSince >= RETURNING_DORMANT_THRESHOLD_DAYS
      ? "returning-dormant"
      : "active";
  }
  if (
    hostedSessionCount === 0 &&
    (guestSessionCount > 0 || participantCount > 0)
  ) {
    return "guest-first";
  }
  return "first-run";
}

/**
 * Compute `OnboardingState` for a user.
 *
 * `messages` is the channel-message stream. The caller (typically the shared
 * schedule-context loader) is responsible for windowing — terminal markers
 * persist regardless, so a wider window is safer than narrower.
 *
 * `now` defaults to `new Date()`; injectable for tests.
 *
 * `profileGapsCount` is passed in (already computed by the schedule-context
 * loader via `computeProfileGaps`) rather than recomputed here, so we don't
 * double-trigger the gaps query.
 */
export async function computeOnboardingState(
  userId: string,
  messages: DatedMessageMetaSlice[],
  profileGapsCount: number,
  now: Date = new Date(),
): Promise<OnboardingState> {
  const [user, messageCount, hostedSessionCount, guestSessionCount, participantCount] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { lastCalibratedAt: true },
      }),
      prisma.channelMessage.count({ where: { channel: { userId } } }),
      prisma.negotiationSession.count({ where: { hostId: userId } }),
      prisma.negotiationSession.count({ where: { guestId: userId } }),
      prisma.sessionParticipant.count({ where: { userId } }),
    ]);

  // Most-recent message overall — drives daysSinceLastChannelMessage and
  // welcome-variant's recency check.
  let lastChannelMessageAt: Date | null = null;
  for (const m of messages) {
    const at = toDate(m.createdAt);
    if (!lastChannelMessageAt || at.getTime() > lastChannelMessageAt.getTime()) {
      lastChannelMessageAt = at;
    }
  }

  const lastTuningCompletionAt = findLatestTerminalMarkerAt(
    messages,
    "primary-link-tuning",
  );
  const lastCalibrationCompletionAt = findLatestTerminalMarkerAt(
    messages,
    "recalibrate",
  );
  const lastPreferencesExtendedAt = findLatestTerminalMarkerAt(
    messages,
    "preferences-extended",
  );

  const lastCalibratedAt = user?.lastCalibratedAt ?? null;
  const daysSinceCalibration = lastCalibratedAt
    ? daysBetween(lastCalibratedAt, now)
    : null;
  const daysSinceLastChannelMessage = lastChannelMessageAt
    ? daysBetween(lastChannelMessageAt, now)
    : null;

  const welcomeVariant = resolveWelcomeVariant({
    messageCount,
    lastChannelMessageAt,
    hostedSessionCount,
    guestSessionCount,
    participantCount,
    now,
  });

  return {
    welcomeVariant,
    daysSinceCalibration,
    daysSinceLastChannelMessage,
    primaryLinkTuningCompleted: lastTuningCompletionAt !== null,
    preferencesExtendedCompleted: lastPreferencesExtendedAt !== null,
    lastTuningCompletionAt,
    lastCalibrationCompletionAt,
    profileGapsCount,
  };
}
