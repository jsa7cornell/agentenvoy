/**
 * Fixture 5 — conversation-history-bleed boundary.
 *
 * The composer extracts a field from a PREVIOUS turn's message rather than
 * the current turn (e.g., user said "MWF, protect lunch" two turns ago,
 * then said "yeah let's lock that in" this turn — composer emits the
 * protection rule). `requiredFieldExtractionCheck` only inspects the
 * current turn, so it doesn't fire here.
 *
 * This fixture documents the deliberate boundary: history-bleed is a
 * DIFFERENT failure class than silent-omission/fabrication; addressing it
 * is sibling-proposal scope, not PR-A's check. The lexical check correctly
 * stays silent when its inputs don't entitle it to an opinion.
 *
 * Per proposal Author Response B4 (conversation-history-bleed entry).
 */
import { describe, it, expect } from "vitest";
import { requiredFieldExtractionCheck } from "@/agent/modules/recalibrate/pre-emit-checks/required-field-extraction";
import {
  action,
  makeFirstTimeContext,
  makeModuleContext,
} from "./_helpers";

const ACK_ONLY_CURRENT_TURN = "yeah, sounds good — go ahead";

describe("recalibrate first-time — conversation-history-bleed (boundary; non-fire)", () => {
  it("does not fire when the current turn names no fields and only a history-grounded availability rule emits", async () => {
    // Composer emits a rule whose content was extracted from a prior turn.
    // `update_availability_rule` has no paramKeys in the field vocabulary, so
    // emitting it without a current-turn lexical hook does not register as
    // fabrication. (A future sibling proposal could add a turn-provenance
    // check; this fixture pins the current behavior.)
    const parsedActions = [
      action("update_availability_rule", {
        operation: "add",
        rule: {
          type: "recurring",
          action: "block",
          timeStart: "12:00",
          timeEnd: "13:00",
          daysOfWeek: [1, 2, 3, 4, 5],
        },
      }),
    ];

    const result = await requiredFieldExtractionCheck.check({
      parsedActions,
      contextOutput: makeFirstTimeContext(ACK_ONLY_CURRENT_TURN),
      moduleContext: makeModuleContext(),
    });

    expect(result).toBeNull();
  });
});
