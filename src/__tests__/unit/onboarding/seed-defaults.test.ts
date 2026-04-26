import { describe, it, expect } from "vitest";
import { buildSeededExplicit } from "@/lib/onboarding/seed-defaults";

describe("buildSeededExplicit", () => {
  it("returns the canonical seed set when no opts given", () => {
    expect(buildSeededExplicit()).toEqual({
      businessHoursStart: 9,
      businessHoursEnd: 17,
      defaultFormat: "video",
      videoProvider: "google_meet",
      defaultDuration: 30,
      bufferMinutes: 0,
      activeCalendarIds: ["primary"],
    });
  });

  it("includes browser-inferred timezone when provided", () => {
    expect(buildSeededExplicit({ timezone: "America/New_York" })).toEqual({
      businessHoursStart: 9,
      businessHoursEnd: 17,
      defaultFormat: "video",
      videoProvider: "google_meet",
      defaultDuration: 30,
      bufferMinutes: 0,
      activeCalendarIds: ["primary"],
      timezone: "America/New_York",
    });
  });

  it("omits timezone when undefined (never writes tz: undefined)", () => {
    const result = buildSeededExplicit({ timezone: undefined });
    expect("timezone" in result).toBe(false);
  });

  it("returns a fresh object on each call (no shared mutation)", () => {
    const a = buildSeededExplicit();
    const b = buildSeededExplicit();
    expect(a).not.toBe(b);
    (a as { extra?: number }).extra = 1;
    expect(b).not.toHaveProperty("extra");
  });

  // Google-seed-everything merges (added 2026-04-26).
  describe("googleSeed merge", () => {
    it("Google timezone wins over browser timezone", () => {
      const result = buildSeededExplicit({
        timezone: "America/New_York", // browser
        googleSeed: { timezone: "America/Los_Angeles" }, // Google
      });
      expect(result.timezone).toBe("America/Los_Angeles");
    });

    it("Google timezone applies even without browser timezone", () => {
      const result = buildSeededExplicit({
        googleSeed: { timezone: "Europe/London" },
      });
      expect(result.timezone).toBe("Europe/London");
    });

    it("merges locale, weekStart, use24HourTime when present", () => {
      const result = buildSeededExplicit({
        googleSeed: {
          locale: "en-GB",
          weekStart: 1,
          use24HourTime: true,
        },
      });
      expect(result).toMatchObject({
        locale: "en-GB",
        weekStart: 1,
        use24HourTime: true,
      });
    });

    it("Google defaultDuration overrides hardcoded 30", () => {
      const result = buildSeededExplicit({
        googleSeed: { defaultDuration: 60 },
      });
      expect(result.defaultDuration).toBe(60);
    });

    it("hardcoded defaultDuration of 30 stands when Google omits it", () => {
      const result = buildSeededExplicit({
        googleSeed: { timezone: "Europe/Berlin" },
      });
      expect(result.defaultDuration).toBe(30);
    });

    it("stores prefersMeet when Google reports it", () => {
      const t = buildSeededExplicit({
        googleSeed: { prefersMeet: true },
      });
      expect(t.prefersMeet).toBe(true);
      const f = buildSeededExplicit({
        googleSeed: { prefersMeet: false },
      });
      expect(f.prefersMeet).toBe(false);
    });

    it("empty googleSeed is a no-op (hardcoded floor stands)", () => {
      const result = buildSeededExplicit({ googleSeed: {} });
      expect(result).toEqual({
        businessHoursStart: 9,
        businessHoursEnd: 17,
        defaultFormat: "video",
        videoProvider: "google_meet",
        defaultDuration: 30,
        bufferMinutes: 0,
        activeCalendarIds: ["primary"],
      });
    });

    it("partial googleSeed with weekStart=0 (Sunday) is preserved", () => {
      // Falsy-but-valid value; bug-bait if we wrote `if (g.weekStart)`.
      const result = buildSeededExplicit({
        googleSeed: { weekStart: 0 },
      });
      expect(result.weekStart).toBe(0);
    });

    it("use24HourTime: false is preserved (not skipped as falsy)", () => {
      const result = buildSeededExplicit({
        googleSeed: { use24HourTime: false },
      });
      expect(result.use24HourTime).toBe(false);
    });
  });
});
