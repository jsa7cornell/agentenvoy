/**
 * Command-to-state regression test #1: "Protect next Tuesday all day".
 *
 * Ground bug (2026-05-05): user said "Protect next Tuesday all day" via the
 * channel composer. The composer emitted an `update_availability_rule` action
 * with `type: "one-time"`, `effectiveDate: "<next Tuesday>"`, and
 * `expiryDate: "<next Tuesday>"` — but no `allDay: true` flag. The compiler
 * at `availability-rules.ts` checked `if (rule.allDay)` and fell through to
 * the time-range branch, producing a windowless `BlockedWindow`
 * (`start: "00:00", end: "23:59"`, no `days` field, no `date` scope) — i.e.
 * "block every day until expires." Calendar overlay went black for the host.
 *
 * If THIS test had existed, the bug couldn't have shipped — the assertion
 * shape encodes the invariant the compiler must maintain.
 *
 * Cross-references:
 *  - meta-proposal `proposals/2026-05-05_state-integrity-and-architectural-attention-bias.md`
 *  - unit test `src/__tests__/unit/availability-rules-compiler.test.ts`
 *    (parallel rule-system-fixes driver) covers the compiler in isolation;
 *    this test covers writer + compiler integrated.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { resetDb } from "../helpers/db";
import { runTurn, seedTestUser, nextTuesdayISO } from "./_harness";

beforeEach(async () => {
  await resetDb();
});

describe("command-to-state — Protect next Tuesday all day", () => {
  test("after the turn, exactly one rule with type=one-time + effectiveDate=expiryDate=<next Tuesday>, AND no compiled blockedWindow is left date-unscoped", async () => {
    const user = await seedTestUser();
    const tuesday = nextTuesdayISO();

    // Synthesized composer emit. Mirrors the action shape the LLM produced
    // in production on 2026-05-05 — note the omitted `allDay` flag, which
    // is the trigger for the compiler bug.
    const composerOutput = [
      "I'll block out next Tuesday for you.",
      `[ACTION]${JSON.stringify({
        action: "update_availability_rule",
        params: {
          operation: "add",
          rule: {
            originalText: "Protect next Tuesday all day",
            type: "one-time",
            action: "block",
            effectiveDate: tuesday,
            expiryDate: tuesday,
          },
        },
      })}[/ACTION]`,
    ].join("\n");

    const result = await runTurn({
      userId: user.id,
      userMessage: "Protect next Tuesday all day",
      composerOutput,
    });

    // Action must succeed.
    expect(result.actionResults).toHaveLength(1);
    expect(result.actionResults[0].success).toBe(true);

    // Exactly one structured rule, with the expected shape.
    expect(result.structuredRules).toHaveLength(1);
    const rule = result.structuredRules[0];
    expect(rule.type).toBe("one-time");
    expect(rule.action).toBe("block");
    expect(rule.effectiveDate).toBe(tuesday);
    expect(rule.expiryDate).toBe(tuesday);
    expect(rule.status).toBe("active");

    // The regression assertion: compiled.blockedWindows must NOT contain a
    // window without `days` and without a single-date scope. Either the
    // rule routes to `blackoutDays` (preferred for all-day) OR to a
    // `BlockedWindow` whose `date` is set to the effectiveDate. A window
    // with neither is the ground bug.
    //
    // `date` is widened from the stricter `BlockedWindow` type because the
    // post-fix compiler will add it and tests must compile against both
    // pre- and post-fix typings (the rule-system-fixes driver lands the
    // field). Once that PR is on main, this cast can be removed.
    for (const bw of result.compiled.blockedWindows as Array<
      (typeof result.compiled.blockedWindows)[number] & { date?: string }
    >) {
      const dateScoped = bw.date === tuesday;
      const dayScoped = Array.isArray(bw.days) && bw.days.length > 0;
      expect(
        dateScoped || dayScoped,
        `BlockedWindow leaked without date or day scope: ${JSON.stringify(bw)}. ` +
          `This is the 2026-05-05 calendar-blackout regression.`,
      ).toBe(true);
    }

    // Belt-and-braces: the date must be captured somewhere in compiled
    // output, either as a blackoutDay or a date-scoped window.
    const hasBlackout = (result.compiled.blackoutDays ?? []).includes(tuesday);
    const hasDateScopedWindow = (
      result.compiled.blockedWindows as Array<
        (typeof result.compiled.blockedWindows)[number] & { date?: string }
      >
    ).some((bw) => bw.date === tuesday);
    expect(hasBlackout || hasDateScopedWindow).toBe(true);
  });
});
