import { describe, it, expect } from "vitest";
import { getSunday } from "@/lib/week-boundaries";

/**
 * Regression tests for the UTC-bleed bug in getSunday.
 *
 * Before the 2026-04-19 fix, getSunday used `toISOString().slice(0,10)` to
 * format its result — which rendered the UTC date. On a Sunday evening in
 * a west-of-UTC timezone, the local clock still said Sunday but UTC had
 * already ticked to Monday. getSunday returned Monday, and the dashboard
 * calendar shifted one day right (Full week rendered Mon–Sun instead of
 * Sun–Sat; Workweek rendered Tue–Sat instead of Mon–Fri).
 *
 * These tests assume the host TZ is America/Los_Angeles (the repo's dev
 * default). CI must run in that TZ — the test file assumes local-tz dates.
 */
describe("getSunday", () => {
  it("returns the local-tz Sunday for a Sunday morning", () => {
    // Sunday 2026-04-19 at 10:00 AM PT → still Sunday
    const d = new Date("2026-04-19T17:00:00Z"); // 10am PT
    expect(getSunday(d)).toBe("2026-04-19");
  });

  it("returns the local-tz Sunday for a Sunday evening (UTC has ticked forward)", () => {
    // Sunday 2026-04-19 at 6:00 PM PT → still Sunday locally, but UTC is
    // already Monday 2026-04-20 at 01:00. This is the exact case that
    // regressed full-week + workweek views.
    const d = new Date("2026-04-20T01:00:00Z"); // 6pm PT Sunday
    expect(getSunday(d)).toBe("2026-04-19");
  });

  it("returns the prior Sunday for a Monday morning", () => {
    const d = new Date("2026-04-20T17:00:00Z"); // 10am PT Monday
    expect(getSunday(d)).toBe("2026-04-19");
  });

  it("returns the same day when called on a Sunday at midnight PT", () => {
    const d = new Date("2026-04-19T07:00:00Z"); // 00:00 PT Sunday
    expect(getSunday(d)).toBe("2026-04-19");
  });

  it("handles end-of-month wrap", () => {
    // Tuesday 2026-03-03 → prior Sunday 2026-03-01
    const d = new Date("2026-03-03T17:00:00Z");
    expect(getSunday(d)).toBe("2026-03-01");
  });

  it("handles year wrap", () => {
    // Saturday 2026-01-03 → prior Sunday 2025-12-28
    const d = new Date("2026-01-03T17:00:00Z");
    expect(getSunday(d)).toBe("2025-12-28");
  });
});
