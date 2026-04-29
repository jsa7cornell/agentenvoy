import { describe, it, expect } from "vitest";
import { applyEventOverrides, type ScoredSlot, type LinkParameters } from "@/lib/scoring";

/**
 * Make a `ScoredSlot` with sensible defaults for testing the blockedRanges
 * filter. Most fields don't matter for the slot-subtraction logic; we just
 * need start/end populated.
 */
function slot(start: string, end: string, score = 0): ScoredSlot {
  return {
    start,
    end,
    score,
    confidence: "high",
    reason: "test",
    kind: "open",
    blockCost: "none",
  };
}

describe("applyEventOverrides — blockedRanges subtraction", () => {
  const tz = "America/Los_Angeles";

  it("drops a slot fully inside a blocked range", () => {
    const slots = [
      slot("2026-04-30T17:00:00-07:00", "2026-04-30T17:30:00-07:00"),
      slot("2026-04-30T18:00:00-07:00", "2026-04-30T18:30:00-07:00"),
    ];
    const rules: LinkParameters = {
      blockedRanges: [{ start: "2026-04-30T17:00:00-07:00", end: "2026-04-30T22:00:00-07:00" }],
    };
    const out = applyEventOverrides(slots, rules, tz);
    expect(out).toEqual([]);
  });

  it("keeps a slot adjacent to the blocked range (end == start)", () => {
    const slots = [
      slot("2026-04-30T16:30:00-07:00", "2026-04-30T17:00:00-07:00"), // ends exactly at block start
    ];
    const rules: LinkParameters = {
      blockedRanges: [{ start: "2026-04-30T17:00:00-07:00", end: "2026-04-30T22:00:00-07:00" }],
    };
    const out = applyEventOverrides(slots, rules, tz);
    expect(out).toHaveLength(1);
  });

  it("drops a slot that partially overlaps the blocked range", () => {
    const slots = [
      slot("2026-04-30T16:45:00-07:00", "2026-04-30T17:15:00-07:00"), // overlaps first 15 min of block
    ];
    const rules: LinkParameters = {
      blockedRanges: [{ start: "2026-04-30T17:00:00-07:00", end: "2026-04-30T22:00:00-07:00" }],
    };
    const out = applyEventOverrides(slots, rules, tz);
    expect(out).toEqual([]);
  });

  it("preserves Thursday morning when only Thursday evening is blocked (the original Bug 2 case)", () => {
    const slots = [
      slot("2026-04-30T09:00:00-07:00", "2026-04-30T09:30:00-07:00"), // Thu morning
      slot("2026-04-30T17:00:00-07:00", "2026-04-30T17:30:00-07:00"), // Thu evening
      slot("2026-05-01T09:00:00-07:00", "2026-05-01T09:30:00-07:00"), // Fri morning
    ];
    const rules: LinkParameters = {
      blockedRanges: [{ start: "2026-04-30T17:00:00-07:00", end: "2026-04-30T22:00:00-07:00" }],
    };
    const out = applyEventOverrides(slots, rules, tz);
    expect(out.map((s) => s.start)).toEqual([
      "2026-04-30T09:00:00-07:00",
      "2026-05-01T09:00:00-07:00",
    ]);
  });

  it("supports multiple blocked ranges", () => {
    const slots = [
      slot("2026-04-30T09:00:00-07:00", "2026-04-30T09:30:00-07:00"),
      slot("2026-04-30T17:00:00-07:00", "2026-04-30T17:30:00-07:00"),
      slot("2026-05-01T09:00:00-07:00", "2026-05-01T09:30:00-07:00"),
    ];
    const rules: LinkParameters = {
      blockedRanges: [
        { start: "2026-04-30T17:00:00-07:00", end: "2026-04-30T22:00:00-07:00" },
        { start: "2026-05-01T08:00:00-07:00", end: "2026-05-01T10:00:00-07:00" },
      ],
    };
    const out = applyEventOverrides(slots, rules, tz);
    expect(out.map((s) => s.start)).toEqual(["2026-04-30T09:00:00-07:00"]);
  });

  it("ignores malformed entries silently (start >= end, unparseable)", () => {
    const slots = [slot("2026-04-30T09:00:00-07:00", "2026-04-30T09:30:00-07:00")];
    const rules: LinkParameters = {
      blockedRanges: [
        { start: "2026-04-30T22:00:00-07:00", end: "2026-04-30T17:00:00-07:00" }, // inverted
        { start: "not a date", end: "also not a date" },
      ],
    };
    const out = applyEventOverrides(slots, rules, tz);
    // Both malformed entries dropped; slot remains.
    expect(out).toHaveLength(1);
  });

  it("is a no-op when blockedRanges is undefined or empty", () => {
    const slots = [slot("2026-04-30T09:00:00-07:00", "2026-04-30T09:30:00-07:00")];
    expect(applyEventOverrides(slots, {}, tz)).toHaveLength(1);
    expect(applyEventOverrides(slots, { blockedRanges: [] }, tz)).toHaveLength(1);
  });
});
