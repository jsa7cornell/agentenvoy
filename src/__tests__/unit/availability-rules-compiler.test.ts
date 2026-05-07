/**
 * Compiler invariants for `compileStructuredRules` — particularly around
 * one-time, date-scoped block rules.
 *
 * Ground bug (2026-05-05): user said "Protect next Tuesday all day" via the
 * composer. Resulting AvailabilityRule had `type: "one-time"` and
 * `effectiveDate: "2026-05-12"` but no `allDay: true` flag. The compiler at
 * `availability-rules.ts:208` checked `if (rule.allDay)` and fell through to
 * the time-range branch which built a window with `start: "00:00"`,
 * `end: "23:59"`, no `days`, and no date scope — meaning "block every day
 * until expires". Calendar overlay went black.
 *
 * Invariant under test: a one-time block rule with an `effectiveDate` MUST
 * route to a date-scoped form (blackoutDays for all-day, BlockedWindow
 * with `date` set for partial-day) regardless of whether `allDay` is set.
 */
import { describe, it, expect } from "vitest";
import { compileStructuredRules, type AvailabilityRule } from "@/lib/availability-rules";

function mkRule(overrides: Partial<AvailabilityRule>): AvailabilityRule {
  return {
    id: "rule_test",
    originalText: "test",
    type: "one-time",
    action: "block",
    status: "active",
    priority: 3,
    createdAt: "2026-05-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("compileStructuredRules — one-time block rules with effectiveDate", () => {
  it("routes one-time block with effectiveDate + no allDay flag to blackoutDays (NOT a windowless time-range block)", () => {
    // Repro of the 2026-05-05 bug: composer omitted allDay flag.
    const rule = mkRule({
      type: "one-time",
      action: "block",
      effectiveDate: "2026-05-12",
      expiryDate: "2026-05-12",
      originalText: "Protect next Tuesday all day",
      // NOTE: no allDay flag, no timeStart/timeEnd
    });

    const compiled = compileStructuredRules([rule]);

    // Must blackout exactly the one date.
    expect(compiled.blackoutDays).toContain("2026-05-12");
    // Must NOT have produced a free-floating "every day until expires" window.
    expect(compiled.blockedWindows).toEqual([]);
  });

  it("routes one-time block with effectiveDate + allDay=true to blackoutDays (existing happy path)", () => {
    const rule = mkRule({
      type: "one-time",
      action: "block",
      allDay: true,
      effectiveDate: "2026-05-12",
      expiryDate: "2026-05-12",
    });

    const compiled = compileStructuredRules([rule]);
    expect(compiled.blackoutDays).toContain("2026-05-12");
    expect(compiled.blockedWindows).toEqual([]);
  });

  it("routes one-time PARTIAL-day block (timeStart/timeEnd + effectiveDate) to a date-scoped BlockedWindow, not an every-day window", () => {
    // E.g. "block 2-4pm on May 12 only"
    const rule = mkRule({
      type: "one-time",
      action: "block",
      timeStart: "14:00",
      timeEnd: "16:00",
      effectiveDate: "2026-05-12",
    });

    const compiled = compileStructuredRules([rule]);

    // Should not produce a blackout day (it's only partial)
    expect(compiled.blackoutDays ?? []).not.toContain("2026-05-12");

    // Should produce ONE blocked window scoped to that date.
    expect(compiled.blockedWindows.length).toBe(1);
    const bw = compiled.blockedWindows[0];
    expect(bw.start).toBe("14:00");
    expect(bw.end).toBe("16:00");
    expect(bw.date).toBe("2026-05-12");
  });

  it("invariant: for any one-time block rule with effectiveDate, no compiled blockedWindow is left date-unscoped", () => {
    const cases: AvailabilityRule[] = [
      mkRule({ type: "one-time", action: "block", effectiveDate: "2026-05-12" }),
      mkRule({ type: "one-time", action: "block", effectiveDate: "2026-05-12", allDay: true }),
      mkRule({ type: "one-time", action: "block", effectiveDate: "2026-05-12", timeStart: "09:00", timeEnd: "10:00" }),
      mkRule({ type: "one-time", action: "block", effectiveDate: "2026-05-12", expiryDate: "2026-05-12" }),
    ];

    for (const rule of cases) {
      const compiled = compileStructuredRules([rule]);
      // For each emitted BlockedWindow, it must be either:
      //   (a) date-scoped to the effectiveDate, OR
      //   (b) absent entirely (because the rule went to blackoutDays)
      for (const bw of compiled.blockedWindows) {
        expect(bw.date).toBe(rule.effectiveDate);
      }
      // And there must be coverage: either blackoutDays OR a date-scoped window.
      const hasBlackout = (compiled.blackoutDays ?? []).includes(rule.effectiveDate!);
      const hasDateScopedWindow = compiled.blockedWindows.some((bw) => bw.date === rule.effectiveDate);
      expect(hasBlackout || hasDateScopedWindow).toBe(true);
    }
  });
});

describe("compileStructuredRules — recurring/ongoing rules unchanged", () => {
  it("recurring all-day block on specific weekdays still produces a 00:00-23:59 BlockedWindow (no date scope)", () => {
    const rule = mkRule({
      type: "recurring",
      action: "block",
      allDay: true,
      daysOfWeek: [6], // Saturdays
    });

    const compiled = compileStructuredRules([rule]);
    expect(compiled.blockedWindows.length).toBe(1);
    expect(compiled.blockedWindows[0].days).toEqual(["Sat"]);
    expect(compiled.blockedWindows[0].date).toBeUndefined();
  });

  it("recurring partial-day block with timeStart/timeEnd produces a date-unscoped window (existing behavior)", () => {
    const rule = mkRule({
      type: "recurring",
      action: "block",
      timeStart: "12:00",
      timeEnd: "13:00",
      daysOfWeek: [1, 2, 3, 4, 5],
    });

    const compiled = compileStructuredRules([rule]);
    expect(compiled.blockedWindows.length).toBe(1);
    expect(compiled.blockedWindows[0].date).toBeUndefined();
    expect(compiled.blockedWindows[0].days).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  });
});
