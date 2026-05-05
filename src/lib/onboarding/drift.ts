/**
 * Calibration drift detection helpers.
 *
 * Introduced in PR-B (onboarding proposal §3.2). The single source of
 * drift-computation logic, shared by:
 *   - `agent/modules/recalibrate/context-loader.ts` (module context builder)
 *   - `app/api/me/scheduling-defaults/route.ts` (PR-E — dormant bubble endpoint)
 *
 * Deliberately pure computation: takes a userId, returns a `DriftAnalysis`
 * describing what has changed since the host's last calibration. Makes
 * one DB read (user preferences) and one Google Calendar API call
 * (`fetchGoogleOnboardingSeed`). Defensive: Google failures return empty
 * seed; drift fields are false / 0 when Google data is unavailable.
 *
 * Per proposal §2.3 / §3.2: any drift field showing `true` in the returned
 * analysis means the host's stored posture differs from what Google's
 * calendar settings currently report.
 */
import { prisma } from "@/lib/prisma";
import { fetchGoogleOnboardingSeed } from "@/lib/google-onboarding-seed";
import { parseChannelMessageMetadata } from "@/lib/channel/metadata-schema";
import type { UserPreferences } from "@/lib/scoring";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftAnalysis {
  /** Days since lastCalibratedAt, or null if never calibrated. */
  daysSinceCalibration: number | null;
  /** Whether the host's stored timezone differs from Google's current timezone. */
  timezoneDrifted: boolean;
  /** Whether the stored default duration differs from what Google reports. */
  durationDrifted: boolean;
  /** Whether the stored business hours have been manually overridden relative
   *  to their initial seeded state. Conservative: only flags if Google reports
   *  a working-hours setting that differs from stored. Usually false because
   *  Google's workingHours is not in settings.list(). */
  hoursDrifted: boolean;
  /** Number of Google Calendar calendars that aren't in the host's
   *  activeCalendarIds — a "new calendar available" signal. 0 if Google
   *  data is unavailable or no new calendars exist. */
  newCalendarsAvailable: number;
  /** The timezone Google currently reports. Null if unavailable. */
  googleTimezone: string | null;
  /** The host's stored (seeded) timezone. */
  storedTimezone: string | null;
  /** The duration Google currently reports (rounded). Null if unavailable. */
  googleDuration: number | null;
  /** The host's stored default duration. */
  storedDuration: number | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function computeCalibrationDrift(userId: string): Promise<DriftAnalysis> {
  // 1. Load user preferences from DB.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      lastCalibratedAt: true,
      preferences: true,
    },
  });

  const prefs = (user?.preferences ?? null) as UserPreferences | null;
  const explicit = prefs?.explicit;
  const storedTimezone =
    explicit?.timezone ?? prefs?.timezone ?? null;
  const storedDuration =
    explicit?.defaultDuration ?? prefs?.defaultDuration ?? null;

  // Days since calibration.
  const lastCalibratedAt = user?.lastCalibratedAt ?? null;
  const daysSinceCalibration = lastCalibratedAt
    ? Math.floor(
        (Date.now() - new Date(lastCalibratedAt).getTime()) / (1000 * 60 * 60 * 24),
      )
    : null;

  // 2. Fetch fresh Google seed — defensive, returns {} on failure.
  let googleSeed: Awaited<ReturnType<typeof fetchGoogleOnboardingSeed>>;
  try {
    googleSeed = await fetchGoogleOnboardingSeed(userId);
  } catch {
    googleSeed = {};
  }

  const googleTimezone = googleSeed.timezone ?? null;
  const googleDuration = googleSeed.defaultDuration ?? null;

  // 3. Compute drift flags.
  const timezoneDrifted =
    googleTimezone !== null &&
    storedTimezone !== null &&
    googleTimezone !== storedTimezone;

  const durationDrifted =
    googleDuration !== null &&
    storedDuration !== null &&
    googleDuration !== storedDuration;

  // hoursDrifted: conservative — only flag if we have a clear mismatch.
  // Google doesn't expose workingHours via settings.list(), so this is
  // almost always false in v1. Placeholder for future enhancement.
  const hoursDrifted = false;

  // newCalendarsAvailable: check Google's calendarList against stored
  // activeCalendarIds. If we can't fetch (no token, etc.), returns 0.
  let newCalendarsAvailable = 0;
  try {
    const activeIds = new Set<string>(
      explicit?.activeCalendarIds ?? [],
    );
    if (activeIds.size > 0 && googleSeed.primaryCalendarId) {
      // If Google's primaryCalendarId isn't in the activeIds, that's one
      // "new" calendar. Full calendarList check would require an extra
      // API call — deferred; this is a lightweight proxy.
      if (!activeIds.has(googleSeed.primaryCalendarId)) {
        newCalendarsAvailable = 1;
      }
    }
  } catch {
    newCalendarsAvailable = 0;
  }

  return {
    daysSinceCalibration,
    timezoneDrifted,
    durationDrifted,
    hoursDrifted,
    newCalendarsAvailable,
    googleTimezone,
    storedTimezone,
    googleDuration,
    storedDuration,
  };
}

// ---------------------------------------------------------------------------
// First-time calibration detection
// ---------------------------------------------------------------------------

/**
 * Action types written by the `manage_setup` cluster (and its absorbed
 * intents). When ANY of these have been emitted by Envoy in the host's
 * channel history, the host has begun managing their setup post-seed —
 * which means they are no longer in the "first-time" calibration window
 * even if `lastCalibratedAt` is still recent.
 *
 * Per proposal `2026-05-05_conversational-onboarding-vision` §2.4a (B2):
 * `recalibrate.first-time` fires only when no manage_setup writes have
 * happened yet. Multi-field edits on calibrated hosts route to
 * `manage_setup` instead.
 */
const MANAGE_SETUP_ACTION_TYPES: ReadonlySet<string> = new Set([
  "update_meeting_settings",
  "update_business_hours",
  "update_availability_rule",
  "update_knowledge",
  "rename_primary",
]);

/** Window after `User.createdAt` during which a host can be considered
 *  in the first-time calibration arc. The seed-everything path stamps
 *  `lastCalibratedAt` at signup, so `daysSinceCalibration === 0` aligns
 *  with `now - createdAt` being well within 24h for fresh signups. */
const FIRST_TIME_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimal shape of a ChannelMessage needed for first-time detection.
 *  Uses `metadata.actions: ActionCall[]` populated by the runner after
 *  every Envoy turn that emitted actions. */
export interface FirstTimeMessageSlice {
  metadata?: unknown;
}

/**
 * Returns true when the host is in the first-time conversational
 * calibration window:
 *
 *  (a) `lastCalibratedAt` is set AND within ~24h of `createdAt` AND today
 *      (`daysSinceCalibration === 0`), AND
 *  (b) no Envoy turn in the channel history has emitted any
 *      `manage_setup`-bucket action.
 *
 * Conservative: returns false when any required input is missing.
 *
 * The optional `messages` arg lets callers avoid a second DB read when
 * they already loaded the channel history. When omitted, the predicate
 * still returns true on (a) alone IF the caller has a separate guarantee
 * that no manage_setup writes exist (e.g., a fresh signup where no
 * channel exists yet). Today's only caller (`recalibrate` contextLoader)
 * passes the messages it already has.
 */
export function isFirstTimeCalibration(
  user: {
    createdAt: Date | null;
    lastCalibratedAt: Date | null;
  },
  daysSinceCalibration: number | null,
  messages?: FirstTimeMessageSlice[],
): boolean {
  if (!user.createdAt || !user.lastCalibratedAt) return false;
  if (daysSinceCalibration === null || daysSinceCalibration !== 0) return false;

  const ageMs = user.lastCalibratedAt.getTime() - user.createdAt.getTime();
  if (ageMs < 0 || ageMs > FIRST_TIME_GRACE_WINDOW_MS) return false;

  // Also gate on now-vs-createdAt — `daysSinceCalibration === 0` already
  // covers "today" but signup grace is the stricter fence.
  const sinceSignupMs = Date.now() - user.createdAt.getTime();
  if (sinceSignupMs > FIRST_TIME_GRACE_WINDOW_MS) return false;

  if (messages && messages.length > 0) {
    for (const m of messages) {
      const meta = parseChannelMessageMetadata(m.metadata);
      const actions = meta.actions;
      if (!actions || actions.length === 0) continue;
      for (const a of actions) {
        if (MANAGE_SETUP_ACTION_TYPES.has(a.action)) return false;
      }
    }
  }

  return true;
}
