import { describe, it, expect } from "vitest";
import {
  computeBilateralAvailability,
  groupBilateralByDay,
  isBookable,
  isProtected,
  isBlocked,
} from "@/lib/bilateral-availability";
import type { ScoredSlot } from "@/lib/scoring";

// Fixed "now" for reproducible tests: Mon Apr 20, 10am PT
const NOW = new Date("2026-04-20T17:00:00.000Z");

// Helper: minimal ScoredSlot factory
function slot(startIso: string, score: number): ScoredSlot {
  const end = new Date(new Date(startIso).getTime() + 30 * 60 * 1000).toISOString();
  return { start: startIso, end, score, kind: "open" } as ScoredSlot;
}

describe("score-band predicates", () => {
  it("isBookable: -2..1 true, 2+ false", () => {
    [-2, -1, 0, 1].forEach((s) => expect(isBookable(s)).toBe(true));
    [2, 3, 4, 5].forEach((s) => expect(isBookable(s)).toBe(false));
  });

  it("isProtected: only 2..3", () => {
    [2, 3].forEach((s) => expect(isProtected(s)).toBe(true));
    [-2, -1, 0, 1, 4, 5].forEach((s) => expect(isProtected(s)).toBe(false));
  });

  it("isBlocked: 4+", () => {
    [4, 5].forEach((s) => expect(isBlocked(s)).toBe(true));
    [-2, -1, 0, 1, 2, 3].forEach((s) => expect(isBlocked(s)).toBe(false));
  });
});

describe("computeBilateralAvailability — guards", () => {
  it("returns [] when guest schedule not available", () => {
    const out = computeBilateralAvailability({
      hostSlots: [slot("2026-04-21T17:00:00.000Z", 0)],
      guestSlots: [slot("2026-04-21T17:00:00.000Z", 0)],
      guestScheduleAvailable: false,
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("returns [] when both schedules are empty", () => {
    const out = computeBilateralAvailability({
      hostSlots: [],
      guestSlots: [],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("skips past slots", () => {
    const past = "2026-04-20T16:00:00.000Z"; // 9am PT, before NOW (10am PT)
    const out = computeBilateralAvailability({
      hostSlots: [slot(past, 0)],
      guestSlots: [slot(past, 0)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out).toEqual([]);
  });
});

describe("computeBilateralAvailability — color logic", () => {
  it("returns GREEN when both host and guest are bookable", () => {
    const iso = "2026-04-21T17:00:00.000Z";
    const out = computeBilateralAvailability({
      hostSlots: [slot(iso, 0)],
      guestSlots: [slot(iso, 1)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: iso, color: "both" });
  });

  it("returns GREEN when both host and guest are preferred (score -1)", () => {
    const iso = "2026-04-21T17:00:00.000Z";
    const out = computeBilateralAvailability({
      hostSlots: [slot(iso, -1)],
      guestSlots: [slot(iso, -1)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out[0].color).toBe("both");
  });

  it("returns ORANGE when host bookable, guest protected (2–3)", () => {
    const iso = "2026-04-21T17:00:00.000Z";
    const out = computeBilateralAvailability({
      hostSlots: [slot(iso, 0)],
      guestSlots: [slot(iso, 2)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0].color).toBe("one");
  });

  it("returns ORANGE for guest score 3 as well", () => {
    const iso = "2026-04-21T17:00:00.000Z";
    const out = computeBilateralAvailability({
      hostSlots: [slot(iso, 0)],
      guestSlots: [slot(iso, 3)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out[0].color).toBe("one");
  });

  it("omits when guest is blocked (score ≥ 4)", () => {
    const iso = "2026-04-21T17:00:00.000Z";
    const out = computeBilateralAvailability({
      hostSlots: [slot(iso, 0)],
      guestSlots: [slot(iso, 4)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("omits when host is not bookable (outside offerable window)", () => {
    const iso = "2026-04-21T17:00:00.000Z";
    const out = computeBilateralAvailability({
      hostSlots: [slot(iso, 2)], // protected — not offerable by default
      guestSlots: [slot(iso, 0)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("omits when guest has no slot at that time (unknown, conservative)", () => {
    const iso = "2026-04-21T17:00:00.000Z";
    const other = "2026-04-21T18:00:00.000Z";
    const out = computeBilateralAvailability({
      hostSlots: [slot(iso, 0)],
      guestSlots: [slot(other, 0)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out).toEqual([]);
  });
});

describe("computeBilateralAvailability — ordering & mixed sets", () => {
  it("sorts output chronologically", () => {
    const later = "2026-04-22T17:00:00.000Z";
    const earlier = "2026-04-21T17:00:00.000Z";
    const out = computeBilateralAvailability({
      hostSlots: [slot(later, 0), slot(earlier, 0)],
      guestSlots: [slot(later, 0), slot(earlier, 0)],
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out.map((s) => s.start)).toEqual([earlier, later]);
  });

  it("handles mixed green + orange + omitted in a realistic set", () => {
    // Tue 10am PT: both open → green
    // Tue 11am PT: host open, guest protected → orange
    // Tue 12pm PT: host open, guest blocked → omit
    // Wed 10am PT: host protected → omit
    // Thu 10am PT: no guest entry → omit
    const hostSlots: ScoredSlot[] = [
      slot("2026-04-21T17:00:00.000Z", 0),
      slot("2026-04-21T18:00:00.000Z", 0),
      slot("2026-04-21T19:00:00.000Z", 0),
      slot("2026-04-22T17:00:00.000Z", 2),
      slot("2026-04-23T17:00:00.000Z", 0),
    ];
    const guestSlots: ScoredSlot[] = [
      slot("2026-04-21T17:00:00.000Z", 0),
      slot("2026-04-21T18:00:00.000Z", 2),
      slot("2026-04-21T19:00:00.000Z", 5),
      slot("2026-04-22T17:00:00.000Z", 0),
      // Thu 10am PT: not present
    ];
    const out = computeBilateralAvailability({
      hostSlots,
      guestSlots,
      guestScheduleAvailable: true,
      now: NOW,
    });
    expect(out).toEqual([
      { start: "2026-04-21T17:00:00.000Z", end: expect.any(String), color: "both" },
      { start: "2026-04-21T18:00:00.000Z", end: expect.any(String), color: "one" },
    ]);
  });
});

describe("groupBilateralByDay", () => {
  it("groups slots by day in the given timezone", () => {
    const slots = [
      { start: "2026-04-21T17:00:00.000Z", end: "2026-04-21T17:30:00.000Z", color: "both" as const },
      { start: "2026-04-21T18:00:00.000Z", end: "2026-04-21T18:30:00.000Z", color: "one" as const },
      { start: "2026-04-22T17:00:00.000Z", end: "2026-04-22T17:30:00.000Z", color: "both" as const },
    ];
    const grouped = groupBilateralByDay(slots, "America/Los_Angeles");
    expect(grouped).toHaveLength(2);
    expect(grouped[0].day).toMatch(/Tue.*Apr 21/);
    expect(grouped[0].slots).toHaveLength(2);
    expect(grouped[1].day).toMatch(/Wed.*Apr 22/);
    expect(grouped[1].slots).toHaveLength(1);
  });

  it("respects timezone for day boundary", () => {
    // 2026-04-22T03:00:00Z = Apr 22 UTC = still Apr 21 8pm PT
    const slots = [
      { start: "2026-04-22T03:00:00.000Z", end: "2026-04-22T03:30:00.000Z", color: "both" as const },
    ];
    const pt = groupBilateralByDay(slots, "America/Los_Angeles");
    const et = groupBilateralByDay(slots, "America/New_York");
    expect(pt[0].day).toMatch(/Tue.*Apr 21/);
    expect(et[0].day).toMatch(/Tue.*Apr 21/); // 11pm ET still Apr 21
  });

  it("returns empty array for empty input", () => {
    expect(groupBilateralByDay([], "America/Los_Angeles")).toEqual([]);
  });
});
