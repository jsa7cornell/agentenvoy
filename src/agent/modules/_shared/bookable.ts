/**
 * Bookable-rule action classifier.
 *
 * Moved from `dispatch-handler.ts` (deleted in PR2). The detection identifies
 * rule writes that create a Bookable Link — used to tag the persisted envoy
 * turn's metadata with `linkKind: "bookable"` so feed.tsx can render the
 * bookable-link card.
 *
 * Vocabulary: `r.action === "bookable"` is the snake-case wire keyword for
 * the **Bookable Link** feature (capitalized in copy). Unrelated to
 * `User.preferences.explicit.businessHoursStart/End` ("Business hours").
 */
import type { ActionRequest } from "@/agent/actions";

/**
 * Returns true iff the action creates (operation:"add") a bookable rule —
 * i.e., the LLM-emitted shape that mints a Bookable Link.
 *
 * `update` / `remove` / `rename_primary` and non-Bookable rule actions
 * (block / allow / buffer / prefer / limit / location / no_in_person) all
 * return false.
 */
export function isBookableAction(action: ActionRequest): boolean {
  if (action.action !== "update_availability_rule") return false;
  const params = action.params as Record<string, unknown>;
  if (params.operation !== "add") return false;
  const rule = params.rule as Record<string, unknown> | undefined;
  if (!rule) return false;
  return rule.action === "bookable";
}
