/**
 * Fixture 3 — F4 silent-omission shape.
 *
 * The user names four distinct fields in one turn; the composer emits two
 * actions covering only a subset (both correct, but partial). The advisory
 * `requiredFieldExtractionCheck` fires for the omitted fields.
 *
 * Per proposal Author Response B4 (silent-omission entry).
 */
import { describe, it, expect } from "vitest";
import { requiredFieldExtractionCheck } from "@/agent/modules/recalibrate/pre-emit-checks/required-field-extraction";
import {
  action,
  makeFirstTimeContext,
  makeModuleContext,
} from "./_helpers";

const PARTIAL_INPUT =
  "My business hours are 9 to 5, I want a comfortable buffer between meetings, " +
  "mostly Zoom, and protect lunch every day.";

describe("recalibrate first-time — silent-omission (F4)", () => {
  it("fires the check when emissions cover only a subset of named fields", async () => {
    // Composer extracted defaultBuffer + defaultFormat but skipped
    // businessHours + the availability rule for lunch protection.
    const parsedActions = [
      action("update_meeting_settings", {
        defaultBuffer: 10,
        defaultFormat: "video",
      }),
    ];

    const result = await requiredFieldExtractionCheck.check({
      parsedActions,
      contextOutput: makeFirstTimeContext(PARTIAL_INPUT),
      moduleContext: makeModuleContext(),
    });

    expect(result).not.toBeNull();
    expect(result!.flaggedReason).toBe("required-field-extraction-omission");
    // Hint references the variant + the surface for retry context.
    expect(result!.hint).toContain("recalibrate.first-time");
    expect(result!.hint).toContain("dashboard-host");
    // The hint enumerates the omitted fields so the composer's retry can
    // ground its re-emission against them.
    expect(result!.hint.toLowerCase()).toMatch(/businesshours|availabilityrule/);
  });
});
