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
import type { MatchResult } from "@/agent/modules/types";
import type { RecalibrateContext } from "./context-loader";

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
 * Priority order:
 *   1. Explicit `matchResult.playbookVariant` (set at the matcher / dispatch
 *      seam) wins. The post-classifier dispatch override in
 *      `app/api/channel/chat/route.ts` stamps `"first-time"` when the latest
 *      envoy turn is a `subkind: "calibrate-opener"` bubble within 30 minutes.
 *   2. `contextOutput.isFirstTime` — fresh-signup post-seed-load fallback.
 *      Safety net for any case where the dispatch override didn't fire but
 *      the host still belongs in the first-time arc.
 *   3. Fallthrough: `"open"`.
 *
 * (Future: dormant > explicit-ask are stamped at the matcher; not yet a
 *  context-derived signal here.)
 */
export function selectVariant(
  matchResult: MatchResult,
  contextOutput: RecalibrateContext,
): RecalibrateVariant {
  // Explicit hint at the matcher/dispatch seam wins.
  if (matchResult.kind === "deterministic" && matchResult.playbookVariant) {
    const v = matchResult.playbookVariant as RecalibrateVariant;
    if (KNOWN_VARIANTS.has(v)) return v;
  }
  // Fresh-signup post-seed-load fallback. The first-time arc is the right
  // home regardless of upstream hint absence — covers cases where the
  // dispatch override (chat/route.ts) didn't fire but the host is still
  // post-seed.
  if (contextOutput.isFirstTime) return "first-time";
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
