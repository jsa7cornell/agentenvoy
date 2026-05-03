/**
 * Tests for the surviving greeting helpers in `src/lib/greeting-template.ts`
 * (post-2026-05-03 trim — see [GREETINGS.md §11.C]). Five test blocks for
 * deleted exports (`formatAvailabilityWindows`, `formatAvailabilitySlotList`,
 * `formatAvailabilityProse`, `alternateFormatsLabel`, host-canonical variant
 * of formatAvailabilityWindows) were removed alongside the dead code.
 *
 * `filterByDuration` lives in `src/lib/scoring.ts`; tests are kept here for
 * historical proximity but logically belong with scoring tests. Move when
 * convenient.
 */

import { describe, it, expect } from "vitest";

import {
  humanTimezoneLabel,
  formatLabel,
  computeCanonicalWeekLabel,
} from "@/lib/greeting-template";
import type { ScoredSlot } from "@/lib/scoring";
import { filterByDuration } from "@/lib/scoring";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slot(
  baseUtcYmd: [number, number, number],
  hour: number,
  minute: number,
  score: number,
): ScoredSlot {
  const [y, m, d] = baseUtcYmd;
  const start = new Date(Date.UTC(y, m - 1, d, hour, minute));
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    score,
    confidence: "high",
    reason: "test",
  };
}

function run(
  baseUtcYmd: [number, number, number],
  startHour: number,
  startMinute: number,
  count: number,
  score: number,
): ScoredSlot[] {
  const slots: ScoredSlot[] = [];
  for (let i = 0; i < count; i++) {
    const total = startHour * 60 + startMinute + i * 30;
    slots.push(slot(baseUtcYmd, Math.floor(total / 60), total % 60, score));
  }
  return slots;
}

// ─── humanTimezoneLabel ──────────────────────────────────────────────────────

describe("humanTimezoneLabel", () => {
  it("renders Pacific / Eastern as simplified 'X time'", () => {
    expect(humanTimezoneLabel("America/Los_Angeles")).toBe("Pacific time");
    expect(humanTimezoneLabel("America/New_York")).toBe("Eastern time");
  });

  it("uses the canonical TIMEZONE_TABLE label for zones in the table", () => {
    expect(humanTimezoneLabel("Asia/Kolkata")).toBe("India time");
  });

  it("never returns a raw UTC offset", () => {
    const label = humanTimezoneLabel("America/Los_Angeles");
    expect(label).not.toMatch(/GMT[+-]/);
    expect(label).not.toMatch(/UTC[+-]/);
  });
});

// ─── formatLabel ─────────────────────────────────────────────────────────────

describe("formatLabel", () => {
  it("maps known formats", () => {
    expect(formatLabel("video")).toBe("video call");
    expect(formatLabel("phone")).toBe("phone call");
    expect(formatLabel("in-person")).toBe("in-person meeting");
  });

  it("returns null for undefined", () => {
    expect(formatLabel(undefined)).toBeNull();
  });

  it("passes through unknown formats verbatim", () => {
    expect(formatLabel("custom")).toBe("custom");
  });
});

// ─── computeCanonicalWeekLabel ───────────────────────────────────────────────

describe("computeCanonicalWeekLabel", () => {
  const TZ = "America/Los_Angeles";

  it("returns null for empty slot lists", () => {
    expect(computeCanonicalWeekLabel([], TZ)).toBeNull();
  });

  it("returns 'this week' when slots fall in the current Monday-Sunday bucket", () => {
    // 2026-04-15 is a Wednesday. Anchor 'now' to that day.
    const now = new Date(Date.UTC(2026, 3, 15, 17, 0));
    // Slot Thursday 2026-04-16 — same week (Mon 4-13 → Sun 4-19).
    const slots = [{ start: new Date(Date.UTC(2026, 3, 16, 17, 0)) }];
    expect(computeCanonicalWeekLabel(slots, TZ, now)).toBe("this week");
  });

  it("returns 'next week' when slots fall in the next Monday-Sunday bucket", () => {
    const now = new Date(Date.UTC(2026, 3, 15, 17, 0)); // Wed
    // Slot Wednesday 2026-04-22 — next week (Mon 4-20 → Sun 4-26).
    const slots = [{ start: new Date(Date.UTC(2026, 3, 22, 17, 0)) }];
    expect(computeCanonicalWeekLabel(slots, TZ, now)).toBe("next week");
  });

  it("returns null when slots span multiple weeks", () => {
    const now = new Date(Date.UTC(2026, 3, 15, 17, 0));
    const slots = [
      { start: new Date(Date.UTC(2026, 3, 16, 17, 0)) }, // this week
      { start: new Date(Date.UTC(2026, 3, 22, 17, 0)) }, // next week
    ];
    expect(computeCanonicalWeekLabel(slots, TZ, now)).toBeNull();
  });
});

// ─── filterByDuration (lives in scoring.ts; tests historically here) ─────────

describe("filterByDuration", () => {
  it("is a pass-through for 30-min meetings", () => {
    const slots = run([2026, 4, 15], 17, 0, 3, 1);
    expect(filterByDuration(slots, 30)).toEqual(slots);
  });

  it("is a pass-through when durationMin is 0 or undefined", () => {
    const slots = run([2026, 4, 15], 17, 0, 3, 1);
    expect(filterByDuration(slots, 0)).toEqual(slots);
  });

  it("keeps only valid start positions for a 60-min meeting", () => {
    // 3 consecutive slots: 10:00, 10:30, 11:00 → valid 60-min starts are 10:00 and 10:30
    const slots = run([2026, 4, 15], 17, 0, 3, 1);
    const filtered = filterByDuration(slots, 60);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].start).toBe(slots[0].start);
    expect(filtered[1].start).toBe(slots[1].start);
  });

  it("removes an isolated 30-min slot that cannot host a 60-min meeting", () => {
    const isolated = [slot([2026, 4, 15], 17, 0, 1)];
    expect(filterByDuration(isolated, 60)).toHaveLength(0);
  });

  it("handles a 90-min meeting requiring 3 consecutive slots", () => {
    const slots = run([2026, 4, 15], 17, 0, 4, 1);
    const filtered = filterByDuration(slots, 90);
    expect(filtered).toHaveLength(2);
  });

  it("works across a gap — non-consecutive slots are correctly excluded", () => {
    const gapped = [
      slot([2026, 4, 15], 17, 0, 1),
      slot([2026, 4, 15], 18, 0, 1),
    ];
    expect(filterByDuration(gapped, 60)).toHaveLength(0);
  });
});
