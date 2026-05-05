/**
 * `create_bookable_link` module — fresh-create variant of the rule pipeline.
 *
 * Per proposal §3 PR2. Behaviorally identical to `rule` (same playbook,
 * context-loader, preEmitChecks, composerTools, allowedActions); the only
 * difference is `moduleGuardBucket: "create-bookable-link"` for corpus
 * segmentation, and the route layer assembles a smaller conversationHistory
 * (historyLimit:0 fresh, historyLimit:4 on continuation) before calling
 * runModule.
 *
 * Why not "just call the rule module"? Bucket separation matters for
 * corpus analysis (we want to know how often guards fire on fresh
 * bookable-link creates vs general rule edits). The dispatch decision
 * lives in chat/route.ts where the classifier intent is observable.
 *
 * The route also handles the `create_link` bookable-fallback branch
 * (chat/route.ts:758 — when classifier returns `create_link` but the
 * message has bookable keywords) by routing to this same module.
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadRuleContext, type RuleContext } from "@/agent/modules/rule/context-loader";
import { fabricatedIdCheck } from "@/agent/modules/rule/pre-emit-checks/fabricated-id";
import { conflictAwarenessGuard } from "@/agent/modules/rule/pre-emit-checks/conflict-awareness";
import { checkConflictsForRule } from "@/agent/modules/_shared/tools/check-conflicts-for-rule";

export const createBookableLinkModule: IntentModule<RuleContext> = {
  intent: "create_bookable_link",
  surface: "dashboard-host",
  description:
    "Mint a new Bookable Link via the calendar-rule composer. Fresh-create variant; route layer caps history.",

  composerPlaybook: [
    "fragments/voice",
    "fragments/ground-truth",
    "composers/calendar-rule-composer",
    "composers/calendar-rule/update",
  ],

  contextLoader: loadRuleContext,

  composerTools: [checkConflictsForRule],

  preEmitChecks: [fabricatedIdCheck, conflictAwarenessGuard],

  postStreamGuards: [],

  allowedActions: ["update_availability_rule", "rename_primary"],

  responseStyle: "human-prose",

  moduleGuardBucket: "create-bookable-link",
};
