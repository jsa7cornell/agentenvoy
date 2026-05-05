/**
 * Command-to-state regression test #3: "Block May 12 9 AM to noon".
 *
 * Two-branch test reflecting the narration↔emission consistency invariant
 * from the post-stream-narration guard's territory. Given a scheduling-
 * adjacent command on a date that may have a shadowed event, the composer
 * must EITHER:
 *
 *   (a) emit a `update_availability_rule` action with the correct scope
 *       (single-date, partial-day window), in which case the resulting
 *       `compiled.blockedWindows` must contain exactly that scope; OR
 *
 *   (b) NOT emit an action and ask for confirmation in prose, in which
 *       case structuredRules must be unchanged from its pre-turn state.
 *
 * The narration↔emission guard validates "if the prose claimed it did X,
 * X must be in the action list." This integration test validates the dual:
 * "whichever branch the composer chose, the resulting DB state matches it."
 *
 * Note on harness scope (per `_harness.ts` docstring): we don't drive the
 * LLM here — we synthesize the action emit. The test parameterizes both
 * branches so a future LLM-in-the-loop variant can pick whichever branch
 * the model produced and assert against the same harness.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { resetDb } from "../helpers/db";
import { runTurn, seedTestUser } from "./_harness";

const MAY_12 = "2026-05-12";

beforeEach(async () => {
  await resetDb();
});

describe("command-to-state — Block May 12 9 AM to noon", () => {
  test("branch (a) — composer emitted a single-date partial-day block: compiled state is correctly scoped", async () => {
    const user = await seedTestUser();

    const composerOutput = [
      "Blocking May 12 from 9 AM to noon.",
      `[ACTION]${JSON.stringify({
        action: "update_availability_rule",
        params: {
          operation: "add",
          rule: {
            originalText: "Block May 12 9 AM to noon",
            type: "one-time",
            action: "block",
            effectiveDate: MAY_12,
            timeStart: "09:00",
            timeEnd: "12:00",
          },
        },
      })}[/ACTION]`,
    ].join("\n");

    const result = await runTurn({
      userId: user.id,
      userMessage: "Block May 12 9 AM to noon",
      composerOutput,
    });

    expect(result.actionResults).toHaveLength(1);
    expect(result.actionResults[0].success).toBe(true);

    // Exactly one rule, matching shape.
    expect(result.structuredRules).toHaveLength(1);
    const rule = result.structuredRules[0];
    expect(rule.action).toBe("block");
    expect(rule.type).toBe("one-time");
    expect(rule.effectiveDate).toBe(MAY_12);
    expect(rule.timeStart).toBe("09:00");
    expect(rule.timeEnd).toBe("12:00");

    // Compiled state must scope to this single date — no
    // every-day-until-expires window, no blackoutDay (it's only partial).
    expect(result.compiled.blackoutDays ?? []).not.toContain(MAY_12);
    // Cast widens BlockedWindow with the post-fix `date` field — see the
    // protect-next-tuesday test's cast for the full rationale.
    const matchingWindows = (
      result.compiled.blockedWindows as Array<
        (typeof result.compiled.blockedWindows)[number] & { date?: string }
      >
    ).filter((bw) => bw.start === "09:00" && bw.end === "12:00");
    expect(matchingWindows).toHaveLength(1);
    expect(matchingWindows[0].date).toBe(MAY_12);
  });

  test("branch (b) — composer asked for confirmation and emitted no action: structuredRules unchanged", async () => {
    const user = await seedTestUser();

    // Composer's narrative ASKS for confirmation rather than acting. This is
    // the legitimate "shadowed event detected" branch — the composer must
    // not silently overwrite, but also must not narrate success it didn't
    // execute. We model that by emitting NO action block.
    const composerOutput =
      "May 12 already has a 'Lunch with Karen' on your calendar at 11:30. " +
      "Want me to block 9 AM–noon on top of it, or pick a different window?";

    const result = await runTurn({
      userId: user.id,
      userMessage: "Block May 12 9 AM to noon",
      composerOutput,
    });

    // No actions were parsed/run — the composer asked for confirmation.
    expect(result.actionsRan).toHaveLength(0);
    expect(result.actionResults).toHaveLength(0);

    // The narration↔emission integration claim: no rule was written.
    expect(result.structuredRules).toHaveLength(0);
    expect(result.compiled.blockedWindows).toHaveLength(0);
    expect(result.compiled.blackoutDays ?? []).toHaveLength(0);
  });
});
