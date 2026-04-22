import { describe, it, expect } from "vitest";
import { buildSeededExplicit } from "@/lib/onboarding/seed-defaults";

describe("buildSeededExplicit", () => {
  it("returns the canonical seed set when no timezone given", () => {
    expect(buildSeededExplicit()).toEqual({
      businessHoursStart: 9,
      businessHoursEnd: 17,
      defaultFormat: "video",
      videoProvider: "google_meet",
      defaultDuration: 30,
      bufferMinutes: 0,
    });
  });

  it("includes timezone when provided", () => {
    expect(buildSeededExplicit({ timezone: "America/New_York" })).toEqual({
      businessHoursStart: 9,
      businessHoursEnd: 17,
      defaultFormat: "video",
      videoProvider: "google_meet",
      defaultDuration: 30,
      bufferMinutes: 0,
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
});
