/**
 * `recalibrate` module context loader — PR-B full implementation.
 *
 * Replaces the PR-A smoke stub with the full `CalibrationDriftContext` shape.
 * Loads:
 *   - Drift analysis (timezone, duration, hours, new calendars) via drift.ts
 *   - Profile gaps (existing computeProfileGaps)
 *   - Recent meeting pattern (median duration last 30 days, override count)
 *
 * Produces a [GROUND TRUTH] CALIBRATION DRIFT block for the composer.
 *
 * Per proposal `2026-05-04_onboarding-as-composer-modules_decided-2026-05-05.md`
 * §3.2 PR-B.
 */
import { prisma } from "@/lib/prisma";
import { computeCalibrationDrift, type DriftAnalysis } from "@/lib/onboarding/drift";
import { computeProfileGaps, type ProfileGap } from "@/lib/profile-gaps";
import type {
  ModuleContext,
  ModuleContextOutput,
  MatchResult,
} from "@/agent/modules/types";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface RecalibrateContext extends ModuleContextOutput {
  /** Days since last calibration, or null if never calibrated. */
  daysSinceCalibration: number | null;
  /** Full drift analysis comparing stored posture to current Google settings. */
  driftAnalysis: DriftAnalysis;
  /** Profile gaps — fields the host hasn't set yet. */
  profileGaps: ProfileGap[];
  /** Recent meeting pattern — helps the composer suggest duration updates. */
  recentMeetingPattern: {
    medianDurationLast30Days: number | null;
    overrideCount: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute the median of an array of numbers. Returns null for empty arrays. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Build the [GROUND TRUTH] CALIBRATION DRIFT block for the composer. */
function buildGroundTruthBlock(
  drift: DriftAnalysis,
  profileGaps: ProfileGap[],
  recentMedian: number | null,
): string {
  const lines: string[] = ["[GROUND TRUTH] CALIBRATION DRIFT"];

  if (drift.daysSinceCalibration !== null) {
    lines.push(`Last calibrated: ${drift.daysSinceCalibration} days ago`);
  } else {
    lines.push("Last calibrated: never");
  }

  if (drift.timezoneDrifted) {
    lines.push(
      `Timezone: stored=${drift.storedTimezone ?? "?"}, Google now reports=${drift.googleTimezone ?? "?"}  ← DRIFTED`,
    );
  } else {
    lines.push(`Timezone: ${drift.storedTimezone ?? "not set"} (current)`);
  }

  if (drift.durationDrifted) {
    lines.push(
      `Default duration: stored=${drift.storedDuration ?? "?"}min, Google reports=${drift.googleDuration ?? "?"}min  ← DRIFTED`,
    );
  } else if (recentMedian !== null && drift.storedDuration !== null && recentMedian !== drift.storedDuration) {
    lines.push(
      `Default duration: ${drift.storedDuration}min (stored). Recent meeting median: ${recentMedian}min  ← PATTERN CHANGE`,
    );
  } else {
    lines.push(`Default duration: ${drift.storedDuration ?? "not set"}min (current)`);
  }

  if (drift.newCalendarsAvailable > 0) {
    lines.push(
      `New calendars available: ${drift.newCalendarsAvailable} (not yet in active set)`,
    );
  }

  if (profileGaps.length > 0) {
    const gapIds = profileGaps.map((g) => g.id).join(", ");
    lines.push(`Profile gaps: ${gapIds}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadRecalibrateContext(
  moduleContext: ModuleContext,
  // matchResult unused in v1; PR-B+ could use playbookVariant from it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _matchResult: MatchResult,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _userMessage: string,
): Promise<RecalibrateContext> {
  const userId = moduleContext.user.id;

  // Run drift detection + profile gaps in parallel.
  const [driftAnalysis, profileGaps] = await Promise.all([
    computeCalibrationDrift(userId),
    computeProfileGaps(userId),
  ]);

  // Recent meeting pattern — last 30 days of agreed sessions.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentSessions = await prisma.negotiationSession.findMany({
    where: {
      hostId: userId,
      status: "agreed",
      agreedTime: { gte: thirtyDaysAgo },
    },
    select: { link: { select: { parameters: true } } },
  });

  const durations: number[] = [];
  let overrideCount = 0;
  for (const session of recentSessions) {
    const params = session.link?.parameters as Record<string, unknown> | null;
    if (params && typeof params.duration === "number") {
      durations.push(params.duration);
      // An "override" is a session whose duration differs from the stored default.
      if (
        driftAnalysis.storedDuration !== null &&
        params.duration !== driftAnalysis.storedDuration
      ) {
        overrideCount++;
      }
    }
  }

  const medianDurationLast30Days = median(durations);
  const recentMeetingPattern = { medianDurationLast30Days, overrideCount };

  // Build context lines and ground truth block.
  const contextLines: string[] = [
    driftAnalysis.daysSinceCalibration !== null
      ? `Last calibrated: ${driftAnalysis.daysSinceCalibration} days ago`
      : "Last calibrated: never",
    driftAnalysis.timezoneDrifted
      ? `Timezone drift detected: stored=${driftAnalysis.storedTimezone}, Google=${driftAnalysis.googleTimezone}`
      : `Timezone: ${driftAnalysis.storedTimezone ?? "not set"}`,
    ...(profileGaps.length > 0
      ? [`Profile gaps: ${profileGaps.map((g) => g.id).join(", ")}`]
      : []),
  ];

  const groundTruthBlock = buildGroundTruthBlock(
    driftAnalysis,
    profileGaps,
    medianDurationLast30Days,
  );

  return {
    contextLines,
    groundTruthBlock,
    daysSinceCalibration: driftAnalysis.daysSinceCalibration,
    driftAnalysis,
    profileGaps,
    recentMeetingPattern,
  };
}
