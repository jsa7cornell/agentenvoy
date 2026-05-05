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
