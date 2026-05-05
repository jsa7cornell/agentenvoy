/**
 * Playbook variant selector for the `recalibrate` module.
 *
 * Returns a variant string that the runner uses to select the appropriate
 * matcher-conditional playbook fragment.
 *
 * Variants:
 *   "first-time"   — fresh signup post-seed-load; conversational calibration
 *                    arc replaces the deterministic 5-step PrimaryLinkFlow.
 *                    Per proposal `2026-05-05_conversational-onboarding-vision`
 *                    §3.1 PR-A. Highest priority — wins over all others.
 *   "open"         — no prior recalibrate messages in thread; fresh start
 *   "dormant"      — entry from the <DormantReturnBubble> chip (returning user)
 *   "explicit-ask" — host explicitly asked to retune without a dormant context
 *
 * The variant is signalled by `matchResult.playbookVariant` set at the
 * matcher / dispatch layer:
 *   - `first-time` is set by PR-B's calendar-picker submit handler when it
 *     dispatches a synthetic message routing to recalibrate; the matcher
 *     (or dispatch wrapper) reads `RecalibrateContext.isFirstTime` from
 *     contextLoader output and stamps `playbookVariant: "first-time"` on
 *     the MatchResult before runModule fires.
 *   - `dormant` is set by the dormant-bubble click handler.
 *   - `explicit-ask` is set when classifier rubric matches retune phrasing.
 *   - `open` is the fallthrough.
 *
 * The runner then loads the appropriate fragment from
 * `runtime-prompts/composers/recalibrate/<variant>.md`.
 */
import type { MatchResult, ModuleContextOutput } from "@/agent/modules/types";

export type RecalibrateVariant =
  | "first-time"
  | "dormant"
  | "explicit-ask"
  | "open";

const KNOWN_VARIANTS: ReadonlySet<RecalibrateVariant> = new Set([
  "first-time",
  "dormant",
  "explicit-ask",
  "open",
]);

/**
 * Select the playbook variant for this recalibrate turn.
 *
 * Priority order: explicit `matchResult.playbookVariant` (set at the matcher/
 * dispatch seam) wins. If it's set to `"first-time"`, that wins over all
 * other signals — the conversational-onboarding arc is the load-bearing
 * post-seed surface and a host-classifier mis-route shouldn't displace it.
 *
 * Otherwise: dormant > explicit-ask > open. Fallthrough is `"open"`.
 */
export function selectVariant(
  matchResult: MatchResult,
  // contextOutput unused in v1; future use: check driftAnalysis to prefer
  // "dormant" when daysSinceCalibration is high.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _contextOutput: ModuleContextOutput,
): RecalibrateVariant {
  if (matchResult.kind === "deterministic" && matchResult.playbookVariant) {
    const v = matchResult.playbookVariant as RecalibrateVariant;
    if (KNOWN_VARIANTS.has(v)) return v;
  }
  return "open";
}

/**
 * Map a variant to its composer fragment path. Used by `module.ts`'s
 * function-form `composerPlaybook` so the runner inlines the right fragment.
 */
export function fragmentPathForVariant(variant: RecalibrateVariant): string {
  switch (variant) {
    case "first-time":
      return "composers/recalibrate/first-time";
    case "dormant":
      return "composers/recalibrate/dormant";
    case "explicit-ask":
      return "composers/recalibrate/explicit-ask";
    case "open":
      return "composers/recalibrate/base";
  }
}
