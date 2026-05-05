/**
 * Rule module — composer-modules architecture's first concrete module on
 * the dashboard-host surface.
 *
 * Per proposal §2.8 + spike validation (wip/composer-modules-spike, 6/6 PASS,
 * 2026-05-04). This is the productionized version of the rule module the
 * spike used to validate the four LLM-behavior assumptions:
 *
 *   1. Fragmented playbooks — voice + ground-truth + calendar-rule-composer
 *      + calendar-rule/update (4 fragments composed via `---` separators)
 *   2. [GROUND TRUTH] CURRENT RULES block actually used by the composer
 *   3. composerTools (`check_conflicts_for_rule`) called when block/location/
 *      no_in_person rules would shadow existing meetings
 *   4. Retry-of-retry convergence on `fabricatedIdCheck` and `conflictAwarenessGuard`
 *
 * Wired into `chat/route.ts:419` per PR1c. Replaces the rule branch's
 * `runDispatchHandler` invocation with `runModule(ruleInput)`.
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadRuleContext, type RuleContext } from "./context-loader";
import { fabricatedIdCheck } from "./pre-emit-checks/fabricated-id";
import { conflictAwarenessGuard } from "./pre-emit-checks/conflict-awareness";
import { checkConflictsForRule } from "@/agent/modules/_shared/tools/check-conflicts-for-rule";

export const ruleModule: IntentModule<RuleContext> = {
  intent: "rule",
  surface: "dashboard-host",
  description:
    "Create or update host availability rules (block, allow, prefer, limit, location, no_in_person, buffer, bookable). " +
    "Carries calendar context for conflict-awareness on block/location/no_in_person sub-actions. " +
    "F14 absorbed: fabricatedIdCheck + [GROUND TRUTH] CURRENT RULES block grounding.",

  composerPlaybook: [
    "fragments/voice",
    "fragments/ground-truth",
    "composers/calendar-rule-composer",          // existing 287-line content (single fragment for PR1c)
    "composers/calendar-rule/update",            // F14 HARD RULE on fabricated ids (was Phase 1's NEW addition)
  ],

  contextLoader: loadRuleContext,

  composerTools: [checkConflictsForRule],

  preEmitChecks: [
    fabricatedIdCheck,                           // F14 absorbed (Phase 2 — channel-state injection via contextLoader)
    conflictAwarenessGuard,                      // conflict-awareness gap (John's 2026-05-04 question)
  ],

  postStreamGuards: [],                          // defaults (Layer 2a/2b/F6) auto-injected by runner

  allowedActions: ["update_availability_rule", "rename_primary"],

  responseStyle: "human-prose",

  moduleGuardBucket: "rule",
};
