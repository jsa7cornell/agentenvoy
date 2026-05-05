/**
 * Manage-setup cluster module — `manage_setup`.
 *
 * PR-C: Collapses `profile`, `rule`, `create_bookable_link`, and
 * `edit_preference` into a single cluster module. Cross-cutting commands
 * (e.g., "set buffer to 15 minutes") now land in one module whose
 * `allowedActions` covers the union, so the composer can emit both
 * `update_meeting_settings` and `update_availability_rule` without triggering
 * silent-strip (proposal §2.9, Reports 7, 10, 12 fix).
 *
 * Cluster name: `manage_setup`
 * Absorbed intents: `edit_preference`, `profile`, `rule`, `create_bookable_link`
 * (all map to `manage_setup` via `INTENT_TO_CLUSTER` in intent.ts)
 *
 * `moduleGuardBucket` is `"manage_setup"`. During the dual-write window,
 * the runner writes `legacyBucket` with the originating intent name via
 * `originatingIntent` from `dispatchModuleAndStream`.
 *
 * F14 preEmitChecks from the rule module are preserved:
 *   - `fabricatedIdCheck`: catches fabricated rule ids (Phase 2 F14 fix)
 *   - `conflictAwarenessGuard`: catches conflict-unaware rule proposals
 *
 * `allowedActions` is the union of profile + rule + create_bookable_link sets.
 * Within-cluster cross-cutting (buffer → profile + rule) is absorbed here;
 * out-of-cluster emits (e.g., `create_link` from this module) still strip
 * with metadata, preserving drift detection for out-of-cluster cases.
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadManageSetupContext, type ManageSetupContext } from "./context-loader";
import { fabricatedIdCheck } from "@/agent/modules/rule/pre-emit-checks/fabricated-id";
import { conflictAwarenessGuard } from "@/agent/modules/rule/pre-emit-checks/conflict-awareness";
import { checkConflictsForRule } from "@/agent/modules/_shared/tools/check-conflicts-for-rule";
import { forwardProjectionConsistencyGuard } from "@/agent/modules/_shared/post-stream-guards";

export const manageSetupModule: IntentModule<ManageSetupContext> = {
  intent: "manage_setup",
  surface: "dashboard-host",
  description:
    "Manage-setup cluster — host profile defaults and availability rules. " +
    "Absorbs edit_preference / profile / rule / create_bookable_link intents. " +
    "Cross-cutting commands (e.g. buffer) emit to both update_meeting_settings " +
    "and update_availability_rule without silent-strip.",
  composerPlaybook: [
    "fragments/voice",
    "composers/manage-setup-composer",
  ],
  contextLoader: loadManageSetupContext,
  composerTools: [checkConflictsForRule],
  preEmitChecks: [
    fabricatedIdCheck,         // F14 absorbed — catches fabricated rule ids
    conflictAwarenessGuard,    // catches conflict-unaware rule proposals
  ],
  // forward-projection-consistency: cluster-allowlisted opt-in (Mode D, 2026-05-05).
  // Catches "Want me to also block Saturday?" projection bleed on rule writes.
  // Structural backstop after prose tunes proved insufficient.
  postStreamGuards: [forwardProjectionConsistencyGuard],
  // Union of profile + rule + create_bookable_link allowedActions.
  // Includes both profile writes and rule writes so cross-cutting commands
  // (e.g., buffer affecting both profile defaults and per-link rules) can
  // emit both without triggering allowed-actions-violation.
  allowedActions: [
    // Profile writes (from profileModule)
    "update_knowledge",
    "update_meeting_settings",
    "update_business_hours",
    // Rule writes (from ruleModule + createBookableLinkModule)
    "update_availability_rule",
    "rename_primary",
  ],
  responseStyle: "human-prose",
  moduleGuardBucket: "manage_setup",
};
