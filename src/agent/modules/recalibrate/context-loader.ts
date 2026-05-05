/**
 * `recalibrate` module context loader — PR-A smoke stub.
 *
 * Returns minimal context for the smoke-mode module. PR-B replaces this
 * with the full `CalibrationDriftContext` shape including drift analysis,
 * Google-settings comparison, profile gaps, and recent meeting pattern.
 *
 * Per proposal `2026-05-04_onboarding-as-composer-modules_decided-2026-05-05.md`
 * §3.1 PR-A: "initially returns just `{contextLines: ["Last calibrated: <N> days ago"]}`
 * with no drift analysis yet (drift detection in PR-B)."
 */
import { prisma } from "@/lib/prisma";
import type {
  ModuleContext,
  ModuleContextOutput,
  MatchResult,
} from "@/agent/modules/types";

export interface RecalibrateContext extends ModuleContextOutput {
  /** Days since last calibration, or null if never calibrated. */
  daysSinceCalibration: number | null;
}

export async function loadRecalibrateContext(
  moduleContext: ModuleContext,
  // matchResult and userMessage unused in PR-A smoke stub; PR-B uses both.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _matchResult: MatchResult,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _userMessage: string,
): Promise<RecalibrateContext> {
  const userId = moduleContext.user.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastCalibratedAt: true },
  });

  const lastCalibratedAt = user?.lastCalibratedAt ?? null;
  const daysSinceCalibration = lastCalibratedAt
    ? Math.floor(
        (Date.now() - new Date(lastCalibratedAt).getTime()) / (1000 * 60 * 60 * 24),
      )
    : null;

  const calibrationLine = daysSinceCalibration !== null
    ? `Last calibrated: ${daysSinceCalibration} days ago`
    : "Last calibrated: never (first-run setup may be incomplete)";

  return {
    contextLines: [calibrationLine],
    groundTruthBlock: undefined,   // PR-B adds the full [GROUND TRUTH] CALIBRATION DRIFT block
    daysSinceCalibration,
  };
}
