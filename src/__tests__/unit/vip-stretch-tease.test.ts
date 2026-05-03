/**
 * computeStretchTease + renderStretchTeaseSentence — VIP first-message
 * tease for sessions with stretch availability.
 *
 * The pattern (per host feedback 2026-05-03 on session 9mr4yy/Susan):
 *   "If those don't work, I could offer 8-9 AM PDT slots. If need be, we
 *    could do evenings or weekends."
 *
 * Tier 1 = stretch1 (score 2) immediately adjacent to business hours →
 * concrete time range. Tier 2 = stretch2 (score 3) + far-from-hours
 * stretch1 + weekend → categorical buckets.
 */
import { describe, it, expect } from "vitest";
import {
  computeStretchTease,
  renderStretchTeaseSentence,
  type StretchTease,
} from "@/agent/composer";
import type { ScoredSlot, LinkParameters } from "@/lib/scoring";

function slot(
  startIso: string,
  endIso: string,
  score: number,
): ScoredSlot {
  return {
    start: startIso,
    end: endIso,
    score,
    confidence: "high",
  } as ScoredSlot;
}

const STANDARD_HOURS_RULES: LinkParameters = {
  isVip: true,
  daysOfWeek: [1, 2, 3, 4, 5],
  // hoursStartMinutes: 540 (9 AM), hoursEndMinutes: 1020 (5 PM)
} as unknown as LinkParameters;

const STANDARD_HOURS_RULES_EXPLICIT = {
  ...STANDARD_HOURS_RULES,
  hoursStartMinutes: 540,
  hoursEndMinutes: 1020,
} as unknown as LinkParameters;

describe("computeStretchTease — Susan VIP link (9mr4yy) replay shape", () => {
  // Subset of stretch slots from the 2026-05-03 guest feedback bundle.
  // Mon May 4: 6-8 AM PDT (score 3), 8-9 AM PDT (score 2), 5-8 PM PDT
  // (score 2 → falls in postEnd-deep because 6 PM > hoursEnd+60).
  // Sat May 9 / Sun May 10: all score 3 across the day.
  it("renders Susan's link as morning-adjacent + evening + weekend deeper", () => {
    const stretch1: ScoredSlot[] = [
      // 8 AM PDT (15:00 UTC) Monday — adjacent before 9 AM
      slot("2026-05-04T15:00:00Z", "2026-05-04T15:30:00Z", 2),
      slot("2026-05-04T15:30:00Z", "2026-05-04T16:00:00Z", 2),
      // 5 PM PDT (00:00 UTC next) Monday — adjacent after 5 PM
      slot("2026-05-05T00:00:00Z", "2026-05-05T00:30:00Z", 2),
      slot("2026-05-05T00:30:00Z", "2026-05-05T01:00:00Z", 2),
    ];
    const stretch2: ScoredSlot[] = [
      // 6-8 AM PDT (13:00-15:00 UTC) Monday — deep before
      slot("2026-05-04T13:00:00Z", "2026-05-04T13:30:00Z", 3),
      slot("2026-05-04T14:30:00Z", "2026-05-04T15:00:00Z", 3),
      // Saturday May 9, 9 AM PDT (16:00 UTC) — weekend
      slot("2026-05-09T16:00:00Z", "2026-05-09T16:30:00Z", 3),
      slot("2026-05-10T20:00:00Z", "2026-05-10T20:30:00Z", 3),
    ];

    const tease = computeStretchTease(
      stretch1,
      stretch2,
      "America/Los_Angeles",
      STANDARD_HOURS_RULES,
    );

    // Adjacent: 8-9 AM PDT (from preStart) AND 5-6 PM PDT (from postEnd).
    expect(tease.adjacentRanges).toContain("8 AM-9 AM PDT");
    expect(tease.adjacentRanges).toContain("5 PM-6 PM PDT");

    // Deeper: earlier mornings (6-8 AM PDT) + weekends. No "evenings" here
    // because all stretch1 evening slots fell in the 5-6 PM adjacent bucket
    // and stretch2 had nothing post-end.
    expect(tease.deeperCategories).toContain("earlier mornings");
    expect(tease.deeperCategories).toContain("weekends");
  });

  it("respects custom hoursStartMinutes / hoursEndMinutes when present", () => {
    // Host with 8 AM-6 PM hours: 7-8 AM PDT (just before 8) is now adjacent.
    const customHoursRules = {
      ...STANDARD_HOURS_RULES,
      hoursStartMinutes: 480, // 8 AM
      hoursEndMinutes: 1080, // 6 PM
    } as unknown as LinkParameters;

    const stretch1: ScoredSlot[] = [
      // 7 AM PDT = 14:00 UTC
      slot("2026-05-04T14:00:00Z", "2026-05-04T14:30:00Z", 2),
    ];

    const tease = computeStretchTease(
      stretch1,
      [],
      "America/Los_Angeles",
      customHoursRules,
    );

    expect(tease.adjacentRanges).toContain("7 AM-8 AM PDT");
  });
});

describe("renderStretchTeaseSentence", () => {
  it("formats adjacent + deeper as a two-clause sentence (matches host's spec)", () => {
    const tease: StretchTease = {
      adjacentRanges: ["8 AM-9 AM PDT"],
      deeperCategories: ["evenings", "weekends"],
    };
    expect(renderStretchTeaseSentence(tease)).toBe(
      "If those don't work, I could offer 8 AM-9 AM PDT slots. If need be, we could do evenings or weekends.",
    );
  });

  it("formats adjacent only (no deeper) without the second clause", () => {
    const tease: StretchTease = {
      adjacentRanges: ["8 AM-9 AM PDT"],
      deeperCategories: [],
    };
    expect(renderStretchTeaseSentence(tease)).toBe(
      "If those don't work, I could offer 8 AM-9 AM PDT slots.",
    );
  });

  it("formats deeper only (no adjacent) with 'open up' framing", () => {
    const tease: StretchTease = {
      adjacentRanges: [],
      deeperCategories: ["weekends"],
    };
    expect(renderStretchTeaseSentence(tease)).toBe(
      "If those don't work, I could open up weekends.",
    );
  });

  it("renders three deeper categories with serial Oxford comma + 'or'", () => {
    const tease: StretchTease = {
      adjacentRanges: [],
      deeperCategories: ["earlier mornings", "evenings", "weekends"],
    };
    expect(renderStretchTeaseSentence(tease)).toBe(
      "If those don't work, I could open up earlier mornings, evenings, or weekends.",
    );
  });

  it("returns empty string when no stretch exists (caller skips emit)", () => {
    expect(renderStretchTeaseSentence({ adjacentRanges: [], deeperCategories: [] })).toBe("");
  });

  it("joins two adjacent ranges with 'or'", () => {
    const tease: StretchTease = {
      adjacentRanges: ["8 AM-9 AM PDT", "5 PM-6 PM PDT"],
      deeperCategories: [],
    };
    expect(renderStretchTeaseSentence(tease)).toBe(
      "If those don't work, I could offer 8 AM-9 AM PDT or 5 PM-6 PM PDT slots.",
    );
  });
});

describe("computeStretchTease — edge cases", () => {
  it("ignores midday stretch1 slots (gaps inside business hours)", () => {
    // A score-2 slot at 2:30 PM (within 9-5 hours) should not appear in
    // adjacentRanges — it's a calendar friction gap, not a stretch.
    const middayStretch1: ScoredSlot[] = [
      slot("2026-05-04T21:30:00Z", "2026-05-04T22:00:00Z", 2), // 2:30 PM PDT
    ];
    const tease = computeStretchTease(
      middayStretch1,
      [],
      "America/Los_Angeles",
      STANDARD_HOURS_RULES_EXPLICIT,
    );
    expect(tease.adjacentRanges).toEqual([]);
    expect(tease.deeperCategories).toEqual([]);
  });

  it("handles weekend-only sessions (deeper categories only)", () => {
    const stretch2: ScoredSlot[] = [
      slot("2026-05-09T16:00:00Z", "2026-05-09T16:30:00Z", 3),
    ];
    const tease = computeStretchTease(
      [],
      stretch2,
      "America/Los_Angeles",
      STANDARD_HOURS_RULES,
    );
    expect(tease.adjacentRanges).toEqual([]);
    expect(tease.deeperCategories).toContain("weekends");
  });
});
