/**
 * Fixture 1 — happy path on the John §2.7a anchor input.
 *
 * Input: the verbatim opener-shaped utterance from §2.7a. Composer extracts
 * defaultDuration (25), defaultBuffer (5), and emits multiple
 * update_availability_rule actions for MWF + lunch + Friday afternoons +
 * Tuesday mornings. `requiredFieldExtractionCheck` should NOT fire — every
 * field the user named has a corresponding emission.
 *
 * Per proposal §3.6 + Author Response B4. Boundary the check must clear
 * cleanly so it doesn't false-positive on the canonical first-time turn.
 */
import { describe, it, expect } from "vitest";
import { requiredFieldExtractionCheck } from "@/agent/modules/recalibrate/pre-emit-checks/required-field-extraction";
import {
  action,
  makeFirstTimeContext,
  makeModuleContext,
} from "./_helpers";

const JOHN_ANCHOR_INPUT =
  "I want to offer MWF, but I protect lunchtime every day. " +
  "My standard meeting slots are 25 minutes, with a 5-minute buffer after each. " +
  "I also protect Friday afternoons and Tuesday mornings.";

describe("recalibrate first-time — happy path (John §2.7a anchor)", () => {
  it("does not fire the check when every named field has a corresponding emission", async () => {
    const parsedActions = [
      action("update_meeting_settings", {
        defaultDuration: 25,
        defaultBuffer: 5,
      }),
      action("update_availability_rule", {
        operation: "add",
        rule: {
          type: "recurring",
          action: "bookable",
          daysOfWeek: [1, 3, 5],
          timeStart: "09:00",
          timeEnd: "17:00",
        },
      }),
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
      action("update_availability_rule", {
        operation: "add",
        rule: {
          type: "recurring",
          action: "block",
          daysOfWeek: [5],
          timeStart: "12:00",
          timeEnd: "17:00",
        },
      }),
      action("update_availability_rule", {
        operation: "add",
        rule: {
          type: "recurring",
          action: "block",
          daysOfWeek: [2],
          timeStart: "00:00",
          timeEnd: "12:00",
        },
      }),
    ];

    const result = await requiredFieldExtractionCheck.check({
      parsedActions,
      contextOutput: makeFirstTimeContext(JOHN_ANCHOR_INPUT),
      moduleContext: makeModuleContext(),
    });

    // The happy-path assertion: no flag. If this test starts failing, the
    // check has a false-positive on the canonical first-time turn — that's
    // a bug in PR-A, NOT in this fixture (per PR-D handoff note).
    expect(result).toBeNull();
  });
});
