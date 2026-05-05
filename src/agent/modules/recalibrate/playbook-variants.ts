/**
 * Playbook variant selector for the `recalibrate` module.
 *
 * Returns a variant string that the runner uses to select the appropriate
 * matcher-conditional playbook fragment. Per proposal §2.4 + §3.2 PR-B.
 *
 * Variants:
 *   "open"         — no prior recalibrate messages in thread; fresh start
 *   "dormant"      — entry from the <DormantReturnBubble> chip (returning user)
 *   "explicit-ask" — host explicitly asked to retune without a dormant context
 *
 * The matcher reads recent ChannelMessages for subkind markers to infer
 * which variant applies. The runner then loads the appropriate fragment
 * from `composers/recalibrate/`.
 */
import type { MatchResult, ModuleContextOutput } from "@/agent/modules/types";

export type RecalibrateVariant = "open" | "dormant" | "explicit-ask";

/**
 * Select the playbook variant for this recalibrate turn.
 *
 * In v1, the variant is derived from the matchResult's playbookVariant field
 * (set by the matcher from recent-thread inspection). Falls back to "open"
 * when no signal is present.
 */
export function selectVariant(
  matchResult: MatchResult,
  // contextOutput unused in v1; future use: check driftAnalysis to prefer
  // "dormant" when daysSinceCalibration is high.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _contextOutput: ModuleContextOutput,
): RecalibrateVariant {
  if (matchResult.kind === "deterministic" && matchResult.playbookVariant) {
    const v = matchResult.playbookVariant;
    if (v === "dormant" || v === "explicit-ask" || v === "open") {
      return v;
    }
  }
  return "open";
}
