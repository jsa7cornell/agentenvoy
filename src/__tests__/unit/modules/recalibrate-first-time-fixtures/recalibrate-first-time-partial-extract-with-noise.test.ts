/**
 * Fixture 6 — partial-extract-with-noise.
 *
 * The user's input mixes structured scheduling fields with unrelated chatter.
 * The composer extracts only the structured part. The check sees full
 * coverage of the lexically-detected fields and stays silent.
 *
 * Per proposal Author Response B4 (partial-extract-with-noise entry).
 */
import { describe, it, expect } from "vitest";
import { requiredFieldExtractionCheck } from "@/agent/modules/recalibrate/pre-emit-checks/required-field-extraction";
import {
  action,
  makeFirstTimeContext,
  makeModuleContext,
} from "./_helpers";

const NOISY_INPUT =
  "Btw I'm super swamped this month, sorry for the delayed reply — " +
  "anyway my standard meeting is 30 min and I prefer Zoom for those.";

describe("recalibrate first-time — partial-extract-with-noise", () => {
  it("does not fire when the composer extracts the structured part of a noisy turn", async () => {
    const parsedActions = [
      action("update_meeting_settings", {
        defaultDuration: 30,
        defaultFormat: "video",
      }),
    ];

    const result = await requiredFieldExtractionCheck.check({
      parsedActions,
      contextOutput: makeFirstTimeContext(NOISY_INPUT),
      moduleContext: makeModuleContext(),
    });

    expect(result).toBeNull();
  });
});
