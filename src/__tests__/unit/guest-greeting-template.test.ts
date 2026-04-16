import { describe, it, expect } from "vitest";
import {
  buildGuestGreeting,
  pickTopSlot,
  formatSlotLabel,
  formatPreferencePattern,
  extractGuestPreferencesSummary,
} from "@/lib/guest-greeting-template";
import type { ScoredSlot } from "@/lib/scoring";

// Fixed "now" for reproducible tests — a Monday morning in Pacific time.
const NOW = new Date("2026-04-20T17:00:00.000Z"); // 10am PT

// Helper: minimal ScoredSlot factory
function slot(startIso: string, score: number): ScoredSlot {
  const end = new Date(new Date(startIso).getTime() + 30 * 60 * 1000).toISOString();
  return { start: startIso, end, score, kind: "open" } as ScoredSlot;
}

describe("pickTopSlot", () => {
  it("returns null when no offerable slots", () => {
    expect(pickTopSlot([], NOW)).toBeNull();
  });

  it("skips past slots", () => {
    const past = slot("2026-04-20T16:00:00.000Z", -1); // 9am PT, before NOW
    const future = slot("2026-04-20T18:00:00.000Z", 0); // 11am PT
    const pick = pickTopSlot([past, future], NOW);
    expect(pick?.start).toBe(future.start);
  });

  it("skips slots above offerable threshold (score > 1)", () => {
    const blocked = slot("2026-04-21T17:00:00.000Z", 3);
    const open = slot("2026-04-21T18:00:00.000Z", 1);
    const pick = pickTopSlot([blocked, open], NOW);
    expect(pick?.start).toBe(open.start);
  });

  it("prefers lower-score (host-preferred) slots over plain-open", () => {
    const plain = slot("2026-04-21T17:00:00.000Z", 1);
    const preferred = slot("2026-04-22T17:00:00.000Z", -1);
    const pick = pickTopSlot([plain, preferred], NOW);
    expect(pick?.start).toBe(preferred.start);
  });

  it("breaks score ties by earliest start", () => {
    const later = slot("2026-04-22T17:00:00.000Z", -1);
    const earlier = slot("2026-04-21T17:00:00.000Z", -1);
    const pick = pickTopSlot([later, earlier], NOW);
    expect(pick?.start).toBe(earlier.start);
  });
});

describe("formatSlotLabel", () => {
  const start = new Date("2026-04-21T17:00:00.000Z"); // Tue 10am PT / 1pm ET

  it("single-TZ when guest and host timezones match", () => {
    const label = formatSlotLabel(start, "America/Los_Angeles", "America/Los_Angeles", NOW);
    expect(label).toMatch(/Tue, Apr 21 · 10:00 AM/);
    expect(label).not.toMatch(/\(/); // no dual-TZ parens
  });

  it("single-TZ when guest TZ is null", () => {
    const label = formatSlotLabel(start, "America/Los_Angeles", null, NOW);
    expect(label).toMatch(/Tue, Apr 21 · 10:00 AM/);
    expect(label).not.toMatch(/\(/);
  });

  it("dual-TZ with guest primary + host secondary when they differ", () => {
    const label = formatSlotLabel(start, "America/Los_Angeles", "America/New_York", NOW);
    // Guest ET primary, host PT in parens
    expect(label).toMatch(/Tue, Apr 21 · 1:00 PM/); // ET
    expect(label).toMatch(/\(10:00 AM/); // PT in parens
  });
});

describe("formatPreferencePattern", () => {
  it("returns null when no preferences", () => {
    expect(formatPreferencePattern({})).toBeNull();
  });

  it("handles format only", () => {
    expect(formatPreferencePattern({ format: "video" })).toBe("video preference");
    expect(formatPreferencePattern({ format: "phone" })).toBe("phone preference");
    expect(formatPreferencePattern({ format: "in-person" })).toBe("in-person preference");
  });

  it("handles preferred-time only", () => {
    expect(formatPreferencePattern({ preferredTimesText: "mornings" })).toBe("mornings preference");
    expect(formatPreferencePattern({ preferredTimesText: "afternoon coffee" })).toBe("afternoons preference");
  });

  it("combines time + format", () => {
    expect(
      formatPreferencePattern({ format: "video", preferredTimesText: "mornings" }),
    ).toBe('"mornings + video" preference');
  });

  it("ignores unknown format values", () => {
    expect(formatPreferencePattern({ format: "hologram" })).toBeNull();
  });
});

describe("extractGuestPreferencesSummary", () => {
  it("returns empty on non-object input", () => {
    expect(extractGuestPreferencesSummary(null)).toEqual({});
    expect(extractGuestPreferencesSummary("string")).toEqual({});
  });

  it("pulls format from explicit", () => {
    expect(
      extractGuestPreferencesSummary({ explicit: { format: "video" } }),
    ).toMatchObject({ format: "video" });
  });

  it("pulls preferredTimes as string", () => {
    expect(
      extractGuestPreferencesSummary({
        explicit: { preferredTimes: "mornings only" },
      }).preferredTimesText,
    ).toBe("mornings only");
  });

  it("summarizes structured preferredTimes into a string", () => {
    expect(
      extractGuestPreferencesSummary({
        explicit: { preferredTimes: { weekdays: { start: "09:00", end: "12:00" } } },
      }).preferredTimesText,
    ).toBeNull(); // object without morning/afternoon/evening keywords → null

    expect(
      extractGuestPreferencesSummary({
        explicit: { preferredTimes: { label: "Mornings only" } },
      }).preferredTimesText,
    ).toBe("mornings");
  });
});

describe("buildGuestGreeting", () => {
  const suziePrefs = {
    format: "video",
    preferredTimesText: "mornings",
  };

  it("returns null when no offerable slots", () => {
    const out = buildGuestGreeting({
      guestFirstName: "Suzie",
      hostFirstName: "John",
      offerableSlots: [],
      guestPreferences: suziePrefs,
      guestTimezone: "America/New_York",
      hostTimezone: "America/Los_Angeles",
      now: NOW,
    });
    expect(out).toBeNull();
  });

  it("builds full greeting with preferences + dual TZ", () => {
    const offerable = [slot("2026-04-21T17:00:00.000Z", -1)]; // Tue 10am PT / 1pm ET, preferred
    const out = buildGuestGreeting({
      guestFirstName: "Suzie",
      hostFirstName: "John",
      offerableSlots: offerable,
      guestPreferences: suziePrefs,
      guestTimezone: "America/New_York",
      hostTimezone: "America/Los_Angeles",
      now: NOW,
    });
    expect(out).toContain("Hey Suzie");
    expect(out).toContain("jumping in for you");
    expect(out).toMatch(/\*\*Tue, Apr 21 · 1:00 PM/); // bold slot label in ET
    expect(out).toContain('"mornings + video" preference');
    expect(out).toContain("John's best slot too");
    expect(out).toContain("Want me to lock it in?");
  });

  it("degrades gracefully without preferences", () => {
    const offerable = [slot("2026-04-21T17:00:00.000Z", 0)];
    const out = buildGuestGreeting({
      guestFirstName: "Suzie",
      hostFirstName: "John",
      offerableSlots: offerable,
      guestPreferences: {},
      guestTimezone: "America/Los_Angeles",
      hostTimezone: "America/Los_Angeles",
      now: NOW,
    });
    expect(out).toContain("Hey Suzie");
    expect(out).toContain("looks like a clean overlap");
    expect(out).not.toContain("preference");
    expect(out).toContain("John's best slot");
  });

  it("handles missing guestFirstName", () => {
    const offerable = [slot("2026-04-21T17:00:00.000Z", 0)];
    const out = buildGuestGreeting({
      guestFirstName: null,
      hostFirstName: "John",
      offerableSlots: offerable,
      guestPreferences: {},
      guestTimezone: null,
      hostTimezone: "America/Los_Angeles",
      now: NOW,
    });
    expect(out).toContain("Hey — jumping in");
    expect(out).not.toContain("Suzie");
  });
});
