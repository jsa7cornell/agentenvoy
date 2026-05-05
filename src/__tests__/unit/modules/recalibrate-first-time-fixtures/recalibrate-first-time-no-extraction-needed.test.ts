/**
 * Fixture 2 — low-information input, no actions emitted.
 *
 * User says "my week looks pretty normal — just standard." Composer asks a
 * clarifying question; emits nothing. Check should NOT fire — it returns
 * null when there are no relevant emissions to compare against (the
 * `relevantActions.length === 0` short-circuit in
 * `required-field-extraction.ts`).
 *
 * Per proposal §3.6 — boundary that the advisory check is silent on
 * clarifying-question turns.
 */
import { describe, it, expect } from "vitest";
import { requiredFieldExtractionCheck } from "@/agent/modules/recalibrate/pre-emit-checks/required-field-extraction";
import { makeFirstTimeContext, makeModuleContext } from "./_helpers";

describe("recalibrate first-time — low-information clarifying turn", () => {
  it("does not fire the check when no actions are emitted", async () => {
    const result = await requiredFieldExtractionCheck.check({
      parsedActions: [],
      contextOutput: makeFirstTimeContext(
        "my week looks pretty normal — just standard",
      ),
      moduleContext: makeModuleContext(),
    });

    expect(result).toBeNull();
  });
});
