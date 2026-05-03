/**
 * Unit tests for the clause builders in `src/agent/greetings/clauses.ts`.
 *
 * These cover each helper in isolation — gating predicates and copy
 * assembly. Integration with the templates (which apply suppression rules
 * on top) is covered in `greeting-registry.test.ts`.
 */

import { describe, it, expect } from "vitest";

import {
  buildCalendarPitch,
  buildDeferralFieldsList,
  buildGuestPickHint,
  buildSuggestAltClause,
} from "@/agent/greetings/clauses";

// ─── buildCalendarPitch ──────────────────────────────────────────────────────

describe("buildCalendarPitch", () => {
  it("returns the pitch when there are >1 bookable slots and viewer is anonymous", () => {
    expect(buildCalendarPitch({ bookableSlotCount: 2, isGuest: false })).toBe(
      "Also, if you connect your calendar I can automagically find the best fit for you! 🗓️",
    );
  });

  it("returns null when there is only 1 bookable slot", () => {
    expect(buildCalendarPitch({ bookableSlotCount: 1, isGuest: false })).toBeNull();
  });

  it("returns null when viewer is a logged-in guest (already has app access)", () => {
    expect(buildCalendarPitch({ bookableSlotCount: 5, isGuest: true })).toBeNull();
  });

  it("returns null when bookableSlotCount is 0", () => {
    expect(buildCalendarPitch({ bookableSlotCount: 0, isGuest: false })).toBeNull();
  });
});

// ─── buildDeferralFieldsList ─────────────────────────────────────────────────

describe("buildDeferralFieldsList", () => {
  const base = { isDirective: false, isOfficeHoursLink: false };

  it("returns null when guestPicks is null", () => {
    expect(buildDeferralFieldsList({ ...base, guestPicks: null })).toBeNull();
  });

  it("returns null when no deferred dimensions are set", () => {
    expect(buildDeferralFieldsList({ ...base, guestPicks: { date: true } })).toBeNull();
  });

  it("renders 'the location' for location-only", () => {
    expect(
      buildDeferralFieldsList({ ...base, guestPicks: { location: true } }),
    ).toBe("the location");
  });

  it("renders 'the location and length' for location + duration in canonical order", () => {
    expect(
      buildDeferralFieldsList({ ...base, guestPicks: { duration: true, location: true } }),
    ).toBe("the location and length");
  });

  it("renders 'the location, length, and format' for all three with Oxford comma", () => {
    expect(
      buildDeferralFieldsList({
        ...base,
        guestPicks: { location: true, duration: true, format: true },
      }),
    ).toBe("the location, length, and format");
  });

  it("treats array-shaped duration / format as opt-in", () => {
    expect(
      buildDeferralFieldsList({ ...base, guestPicks: { duration: [30, 60] } }),
    ).toBe("the length");
    expect(
      buildDeferralFieldsList({ ...base, guestPicks: { format: ["video", "phone"] } }),
    ).toBe("the format");
  });

  it("returns null when isDirective is true (narrow / exclusive steering)", () => {
    expect(
      buildDeferralFieldsList({
        guestPicks: { location: true },
        isDirective: true,
        isOfficeHoursLink: false,
      }),
    ).toBeNull();
  });

  it("returns null when isOfficeHoursLink is true", () => {
    expect(
      buildDeferralFieldsList({
        guestPicks: { location: true },
        isDirective: false,
        isOfficeHoursLink: true,
      }),
    ).toBeNull();
  });
});

// ─── buildGuestPickHint (unreachable in production, but copy is authoritative) ─

describe("buildGuestPickHint", () => {
  const base = { hostFirstName: "John", guestGuidance: null };

  it("returns null when guestPicks is null", () => {
    expect(buildGuestPickHint({ ...base, guestPicks: null })).toBeNull();
  });

  it("returns null when neither location nor duration is opt-in", () => {
    expect(
      buildGuestPickHint({ ...base, guestPicks: { format: true } }),
    ).toBeNull();
  });

  it("renders 'where works for you' when location-only", () => {
    expect(
      buildGuestPickHint({ ...base, guestPicks: { location: true } }),
    ).toBe("Let me know where works for you.");
  });

  it("renders 'how long works for you' when duration-only", () => {
    expect(
      buildGuestPickHint({ ...base, guestPicks: { duration: true } }),
    ).toBe("Let me know how long works for you.");
  });

  it("renders 'where and how long' when both opt-in", () => {
    expect(
      buildGuestPickHint({ ...base, guestPicks: { location: true, duration: true } }),
    ).toBe("Let me know where and how long works for you.");
  });

  it("appends a single host-suggested location", () => {
    expect(
      buildGuestPickHint({
        hostFirstName: "John",
        guestPicks: { location: true },
        guestGuidance: { suggestions: { locations: ["Sightglass"] } },
      }),
    ).toBe("Let me know where works for you — John suggested Sightglass.");
  });

  it("joins two host-suggested locations with 'or'", () => {
    expect(
      buildGuestPickHint({
        hostFirstName: "John",
        guestPicks: { location: true },
        guestGuidance: { suggestions: { locations: ["Sightglass", "Verve"] } },
      }),
    ).toBe("Let me know where works for you — John suggested Sightglass or Verve.");
  });

  it("joins three+ host-suggested locations with Oxford comma + 'or'", () => {
    expect(
      buildGuestPickHint({
        hostFirstName: "John",
        guestPicks: { location: true },
        guestGuidance: { suggestions: { locations: ["A", "B", "C"] } },
      }),
    ).toBe("Let me know where works for you — John suggested A, B, or C.");
  });
});

// ─── buildSuggestAltClause (unreachable in production) ───────────────────────

describe("buildSuggestAltClause", () => {
  const base = { isDirective: false, isOfficeHoursLink: false };

  it("returns null when guestPicks is null", () => {
    expect(
      buildSuggestAltClause({ ...base, guestPicks: null }),
    ).toBeNull();
  });

  it("returns null when neither format nor duration is opt-in", () => {
    expect(
      buildSuggestAltClause({ ...base, guestPicks: { location: true } }),
    ).toBeNull();
  });

  it("returns the format-only variant", () => {
    expect(
      buildSuggestAltClause({ ...base, guestPicks: { format: true } }),
    ).toBe("and feel free to suggest a different format if that's better for you");
  });

  it("returns the duration-only variant", () => {
    expect(
      buildSuggestAltClause({ ...base, guestPicks: { duration: true } }),
    ).toBe("and feel free to suggest a different meeting length if that's better for you");
  });

  it("returns the combined variant when both are opt-in", () => {
    expect(
      buildSuggestAltClause({
        ...base,
        guestPicks: { format: true, duration: true },
      }),
    ).toBe("and feel free to suggest a different format or meeting length if that's better for you");
  });

  it("returns null for directive steering", () => {
    expect(
      buildSuggestAltClause({
        guestPicks: { format: true },
        isDirective: true,
        isOfficeHoursLink: false,
      }),
    ).toBeNull();
  });

  it("returns null for office-hours links", () => {
    expect(
      buildSuggestAltClause({
        guestPicks: { format: true },
        isDirective: false,
        isOfficeHoursLink: true,
      }),
    ).toBeNull();
  });
});
