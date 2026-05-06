/**
 * `recalibrate` module — host calibration arc on `dashboard-host`.
 *
 * Sixth module on the dashboard-host surface, distinct from the five clusters
 * (event_action, manage_setup, inquire, chat, book_with_person). NOT collapsed
 * into manage_setup per §9.8 of the prior decided proposal — drift detection +
 * dormant re-engagement is orthogonal to in-flight preference management.
 *
 * Variants (selected via `matchResult.playbookVariant`):
 *   - `first-time`   — post-seed conversational calibration (PR-A; this PR).
 *                      Replaces the deterministic 5-step PrimaryLinkFlow as
 *                      the post-seed-load experience for new hosts.
 *   - `dormant`      — returning user via the dormant-bubble chip.
 *   - `explicit-ask` — explicit retune phrasing.
 *   - `open`         — fallthrough; uses `base.md`.
 *
 * Per proposals:
 *   `2026-05-04_onboarding-as-composer-modules_decided-2026-05-05.md` §3.1 PR-A
 *   `2026-05-05_conversational-onboarding-vision_decided-2026-05-05.md` §3.1 PR-A
 *
 * **B1 — naming.** Per the 2026-05-05 Author Response, the rename
 * `recalibrate` → `calibrate` is DEFERRED to a post-2026-05-19 cleanup PR.
 * This PR ships under the existing name; module path, intent, and
 * `moduleGuardBucket` remain `"recalibrate"`.
 *
 * allowedActions (widened in PR-A for first-time multi-action emit):
 *   - `update_meeting_settings` — host's primary preference fields
 *     (timezone, defaultDuration, defaultBuffer, defaultFormat,
 *     phone, videoLink). Re-stamps lastCalibratedAt server-side.
 *   - `update_business_hours` — explicit business hours write.
 *   - `update_availability_rule` — protections / windows extracted from
 *     a first-time arc ("I protect lunchtime", "MWF availability").
 *   - `update_knowledge` — freeform context surfaced mid-calibration.
 *
 * legacyBucket: undefined — this is a new module, not a renamed cluster.
 * moduleGuardBucket: "recalibrate" — 1:1 mapping in INTENT_TO_CLUSTER.
 */
import type { IntentModule, MatchResult } from "@/agent/modules/types";
import { loadRecalibrateContext, type RecalibrateContext } from "./context-loader";
import {
  fragmentPathForVariant,
  selectVariant,
  type RecalibrateVariant,
} from "./playbook-variants";
import { requiredFieldExtractionCheck } from "./pre-emit-checks/required-field-extraction";

/**
 * Resolve the recalibrate variant from a MatchResult without requiring
 * contextOutput. Used as the pre-context fallback when the runner asks for
 * the static playbook before context-load. Post-load, `selectVariant` is
 * preferred — it also reads `RecalibrateContext.isFirstTime`.
 */
function variantFromMatch(matchResult: MatchResult): RecalibrateVariant {
  if (matchResult.kind === "deterministic" && matchResult.playbookVariant) {
    const v = matchResult.playbookVariant;
    if (
      v === "first-time" ||
      v === "dormant" ||
      v === "explicit-ask" ||
      v === "open"
    ) {
      return v;
    }
  }
  return "open";
}
// `selectVariant` is the canonical post-context selector; re-exported so
// PR-B's dispatch wrapper can call it after contextLoader runs.
export { selectVariant };

export const recalibrateModule: IntentModule<RecalibrateContext> = {
  intent: "recalibrate",
  surface: "dashboard-host",
  description:
    "Multi-field calibration arc. Variants: `first-time` (post-seed " +
    "conversational onboarding), `dormant` (returning host re-engagement), " +
    "`explicit-ask` (host typed a retune phrase), `open` (fallthrough). " +
    "Distinguished from edit_preference / manage_setup (single-field or " +
    "multi-field edits on already-calibrated hosts) by entry-window scope.",

  // Function-form composerPlaybook: the runner passes `contextOutput` after
  // the contextLoader runs, so `selectVariant` can read `isFirstTime` as a
  // post-seed fallback. When called pre-context (no second arg), we fall
  // back to the matcher-only resolver.
  composerPlaybook: (matchResult, contextOutput) => {
    const variant = contextOutput
      ? selectVariant(matchResult, contextOutput as RecalibrateContext)
      : variantFromMatch(matchResult);
    return ["fragments/voice", fragmentPathForVariant(variant)];
  },

  contextLoader: loadRecalibrateContext,

  composerTools: [],

  preEmitChecks: [
    // Per Author Response B4: multi-action-emit fidelity check ships in PR-A.
    // Severity advisory — exhausted retries ship original with
    // `moduleGuard.requiredFieldExtractionCheck.exhaustedRetries: true`.
    requiredFieldExtractionCheck,
  ],

  postStreamGuards: [],             // defaults Layer 2a/2b/F6 auto-injected

  allowedActions: [
    "update_meeting_settings",       // primary preferences (re-stamps lastCalibratedAt)
    "update_business_hours",         // explicit business hours
    "update_availability_rule",      // protections + windows from first-time arc
    "update_knowledge",              // freeform context mid-calibration
  ],

  responseStyle: "human-prose",

  moduleGuardBucket: "recalibrate",
};
