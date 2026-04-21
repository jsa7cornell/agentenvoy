import { describe, it, expect } from "vitest";
import { detectRegion, smartQuickPicks } from "@/lib/timezone";

describe("detectRegion", () => {
  it("classifies by IANA prefix", () => {
    expect(detectRegion("America/Los_Angeles")).toBe("americas");
    expect(detectRegion("America/New_York")).toBe("americas");
    expect(detectRegion("Europe/Paris")).toBe("europe");
    expect(detectRegion("Europe/London")).toBe("europe");
    expect(detectRegion("Asia/Tokyo")).toBe("asia-pacific");
    expect(detectRegion("Australia/Sydney")).toBe("asia-pacific");
    expect(detectRegion("Pacific/Auckland")).toBe("asia-pacific");
  });

  it("returns 'other' for unknown / falsy / unsupported prefixes", () => {
    expect(detectRegion(null)).toBe("other");
    expect(detectRegion(undefined)).toBe("other");
    expect(detectRegion("")).toBe("other");
    expect(detectRegion("Africa/Cairo")).toBe("other");
    expect(detectRegion("Antarctica/McMurdo")).toBe("other");
  });
});

describe("smartQuickPicks", () => {
  it("leads with host tz, then detected guest tz when different", () => {
    const chips = smartQuickPicks("America/Los_Angeles", "America/New_York");
    expect(chips[0]).toBe("America/Los_Angeles");
    expect(chips[1]).toBe("America/New_York");
    expect(chips.length).toBe(4);
  });

  it("dedupes when guest tz equals host tz", () => {
    const chips = smartQuickPicks("America/Los_Angeles", "America/Los_Angeles");
    const unique = new Set(chips);
    expect(unique.size).toBe(chips.length);
    expect(chips[0]).toBe("America/Los_Angeles");
  });

  it("returns 4 chips when no guest tz is available (host-region fallback)", () => {
    const chips = smartQuickPicks("America/Los_Angeles", null);
    expect(chips).toHaveLength(4);
    expect(chips[0]).toBe("America/Los_Angeles");
    // Americas fallback is PT, ET, CT, MT — all should be covered.
    expect(chips).toContain("America/New_York");
  });

  it("LA host + Tokyo guest yields region-diverse chips", () => {
    const chips = smartQuickPicks("America/Los_Angeles", "Asia/Tokyo");
    expect(chips).toHaveLength(4);
    expect(chips[0]).toBe("America/Los_Angeles");
    expect(chips[1]).toBe("Asia/Tokyo");
    // Guest is asia-pacific — remaining chips come from APAC bucket.
    const asianChips = chips.filter((c) => c.startsWith("Asia/") || c.startsWith("Australia/"));
    expect(asianChips.length).toBeGreaterThanOrEqual(2);
  });

  it("Paris guest + LA host uses europe bucket for fill", () => {
    const chips = smartQuickPicks("America/Los_Angeles", "Europe/Paris");
    expect(chips[0]).toBe("America/Los_Angeles");
    expect(chips[1]).toBe("Europe/Paris");
    // europe bucket includes London — should surface in remaining slots.
    expect(chips).toContain("Europe/London");
  });

  it("falls back to host region when guest region is 'other'", () => {
    const chips = smartQuickPicks("America/Los_Angeles", "Africa/Cairo");
    expect(chips[0]).toBe("America/Los_Angeles");
    expect(chips[1]).toBe("Africa/Cairo");
    // Host is Americas → fill with Americas bucket.
    expect(chips).toContain("America/New_York");
  });

  it("never exceeds 4 chips and never produces duplicates", () => {
    const cases: Array<[string, string | null]> = [
      ["America/Los_Angeles", "America/New_York"],
      ["America/Los_Angeles", null],
      ["Europe/London", "Europe/Paris"],
      ["Asia/Tokyo", "America/Los_Angeles"],
    ];
    for (const [h, g] of cases) {
      const chips = smartQuickPicks(h, g);
      expect(chips.length).toBeLessThanOrEqual(4);
      expect(new Set(chips).size).toBe(chips.length);
      expect(chips[0]).toBe(h);
    }
  });
});
