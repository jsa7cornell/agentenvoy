/**
 * `recalibrate` module — new host intent on `dashboard-host`.
 *
 * Sixth module on the dashboard-host surface, distinct from the five clusters
 * (event_action, manage_setup, inquire, chat, book_with_person). NOT collapsed
 * into manage_setup per §9.8 of the decided proposal — drift detection +
 * dormant re-engagement is orthogonal to in-flight preference management.
 *
 * Per proposal `2026-05-04_onboarding-as-composer-modules_decided-2026-05-05.md`
 * §3.1 PR-A + §9.8 cluster-collapse reconciliation.
 *
 * PR-A: smoke context loader (days since calibration only).
 * PR-B: replaces contextLoader with full CalibrationDriftContext.
 *
 * allowedActions:
 *   - `update_meeting_settings` — write calibrated preferences back to the host's profile
 *   - `update_knowledge` — capture freeform knowledge surfaced mid-recalibration
 *
 * legacyBucket: undefined — this is a new module, not a renamed cluster.
 * moduleGuardBucket: "recalibrate" — 1:1 mapping in INTENT_TO_CLUSTER.
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadRecalibrateContext, type RecalibrateContext } from "./context-loader";

export const recalibrateModule: IntentModule<RecalibrateContext> = {
  intent: "recalibrate",
  surface: "dashboard-host",
  description:
    "Re-engages a host whose seeded posture is stale or who explicitly asks to " +
    "retune. Multi-field calibration arc: surfaces drift, walks through key " +
    "preference fields, re-stamps lastCalibratedAt on completion. Distinguished " +
    "from edit_preference (single-field) by multi-field intent scope.",

  composerPlaybook: [
    "fragments/voice",
    "composers/recalibrate/base",
  ],

  contextLoader: loadRecalibrateContext,

  composerTools: [],

  preEmitChecks: [],

  postStreamGuards: [],             // defaults Layer 2a/2b/F6 auto-injected

  allowedActions: [
    "update_meeting_settings",       // write calibrated preferences (also re-stamps lastCalibratedAt)
    "update_knowledge",              // capture freeform knowledge mid-recalibration
  ],

  responseStyle: "human-prose",

  moduleGuardBucket: "recalibrate",
};
