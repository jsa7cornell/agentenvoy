/**
 * `fabricatedIdCheck` — deterministic preEmitCheck.
 *
 * F14 absorbed into a per-module check. Catches:
 *   `update_availability_rule` with `operation: "update" | "remove"` and an
 *   `id` that isn't in the host's known rule ids.
 *
 * Severity: blocking — when retries exhaust, ship fallbackProse and skip
 * action emission (per N3). The fallback prose names what the host probably
 * wanted (an `add` action) so the conversation can recover.
 */
import type { PreEmitCheck } from "@/agent/modules/types";
import type { RuleContext } from "../context-loader";

export const fabricatedIdCheck: PreEmitCheck<RuleContext> = {
  name: "fabricated-id-check",
  severity: "blocking",
  check: async ({ parsedActions, contextOutput }) => {
    const recentRuleIds = new Set(contextOutput.recentRules.map((r) => r.id));

    for (const action of parsedActions) {
      if (action.action !== "update_availability_rule") continue;
      const params = action.params as {
        operation?: string;
        id?: string;
        rule?: Record<string, unknown>;
      };
      if (params.operation !== "update" && params.operation !== "remove") continue;
      if (!params.id) continue;
      if (recentRuleIds.has(params.id)) continue;

      const knownIds = [...recentRuleIds].slice(0, 5).join(", ") || "(none — host has no rules yet)";
      return {
        flaggedReason: "rule-id-not-found",
        hint: `Your action used id "${params.id}" with operation "${params.operation}", but that id doesn't exist on the host's account. Real rule ids are in the [GROUND TRUTH] CURRENT RULES block (recent: ${knownIds}). The fix is one of:\n- If the host's intent is to CREATE a new rule, re-emit with operation:"add" (no id needed).\n- If they want to update an existing rule, find the right id in [GROUND TRUTH] and use it verbatim.\n- If you're unsure which rule they mean, ask them — never guess.`,
        fallbackProse: `I tried to update an existing rule but couldn't find one with that id. Could you tell me which rule you'd like me to change, or should I create a new one instead?`,
      };
    }
    return null;
  },
};
