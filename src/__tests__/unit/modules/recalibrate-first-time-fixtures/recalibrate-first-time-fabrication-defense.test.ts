/**
 * Fixture 4 — F14 fabrication defense.
 *
 * The user names availability-shape fields (MWF + lunch protection) but says
 * nothing about phone. The composer emits an `update_availability_rule` for
 * the protection (correct) AND an `update_meeting_settings { phone: ... }`
 * (fabricated — the user never named a phone field). The check fires with
 * the fabrication branch.
 *
 * Per proposal §3.6 + Author Response B4 (fabrication entry).
 */
import { describe, it, expect } from "vitest";
import { requiredFieldExtractionCheck } from "@/agent/modules/recalibrate/pre-emit-checks/required-field-extraction";
import {
  action,
  makeFirstTimeContext,
  makeModuleContext,
} from "./_helpers";

const NO_PHONE_INPUT = "I do MWF mostly, protect lunchtime.";

describe("recalibrate first-time — fabrication defense (F14)", () => {
  it("fires the check when an emission carries a field the user never named", async () => {
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
      // The fabricated emission — user said nothing about phone.
      action("update_meeting_settings", {
        phone: "+1-555-555-0100",
      }),
    ];

    const result = await requiredFieldExtractionCheck.check({
      parsedActions,
      contextOutput: makeFirstTimeContext(NO_PHONE_INPUT),
      moduleContext: makeModuleContext(),
    });

    expect(result).not.toBeNull();
    expect(result!.flaggedReason).toBe("required-field-extraction-fabrication");
    expect(result!.hint).toContain("recalibrate.first-time");
    expect(result!.hint.toLowerCase()).toContain("phone");
  });
});
