import { describe, it, expect } from "vitest";
import { parseTimeOfDay, TIME_OF_DAY_WINDOWS, slotStartInWindow } from "@/lib/time-of-day";

describe("parseTimeOfDay", () => {
  it("returns null for empty / non-string input", () => {
    expect(parseTimeOfDay(null)).toBeNull();
    expect(parseTimeOfDay(undefined)).toBeNull();
    expect(parseTimeOfDay("")).toBeNull();
  });

  it("matches morning / afternoon / evening case-insensitively", () => {
    expect(parseTimeOfDay("book a hike this afternoon")).toEqual(TIME_OF_DAY_WINDOWS.afternoon);
    expect(parseTimeOfDay("Tomorrow MORNING works")).toEqual(TIME_OF_DAY_WINDOWS.morning);
    expect(parseTimeOfDay("pick an evening slot")).toEqual(TIME_OF_DAY_WINDOWS.evening);
  });

  it("returns first phrase match when multiple appear", () => {
    // Morning listed before afternoon in the patterns table.
    expect(parseTimeOfDay("morning or afternoon is fine")).toEqual(TIME_OF_DAY_WINDOWS.morning);
  });

  it("ignores phrases embedded in other words", () => {
    // "amusement" contains "use" — make sure morning/afternoon can't false-match.
    expect(parseTimeOfDay("amusement park")).toBeNull();
  });

  it("afternoon window is 12–17", () => {
    expect(TIME_OF_DAY_WINDOWS.afternoon).toEqual({ startHour: 12, endHour: 17 });
  });
});

describe("slotStartInWindow", () => {
  // A Friday at noon America/Los_Angeles = 19:00 UTC.
  const NOON_PT = "2026-04-17T19:00:00Z";
  const ELEVEN_AM_PT = "2026-04-17T18:00:00Z";
  const FIVE_PM_PT = "2026-04-18T00:00:00Z"; // 00:00 UTC Sat = 5 PM Fri PT
  const afternoon = { startHour: 12, endHour: 17 };

  it("includes slots starting at window start", () => {
    expect(slotStartInWindow(NOON_PT, afternoon, "America/Los_Angeles")).toBe(true);
  });

  it("excludes slots before window start", () => {
    expect(slotStartInWindow(ELEVEN_AM_PT, afternoon, "America/Los_Angeles")).toBe(false);
  });

  it("excludes slots starting at window end (exclusive)", () => {
    expect(slotStartInWindow(FIVE_PM_PT, afternoon, "America/Los_Angeles")).toBe(false);
  });

  it("evaluates hour in the PROVIDED timezone not UTC", () => {
    // Noon UTC = 8 AM EDT, morning — afternoon window should exclude.
    const noonUtc = "2026-04-17T12:00:00Z";
    expect(slotStartInWindow(noonUtc, afternoon, "America/New_York")).toBe(false);
    // Same instant in PT is 5 AM — also excluded.
    expect(slotStartInWindow(noonUtc, afternoon, "America/Los_Angeles")).toBe(false);
    // Same instant in CET is 2 PM — included.
    expect(slotStartInWindow(noonUtc, afternoon, "Europe/Paris")).toBe(true);
  });
});
