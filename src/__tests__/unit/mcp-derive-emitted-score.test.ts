import { describe, it, expect } from "vitest";
import { deriveEmittedScore, deriveEmittedPreferred } from "@/lib/scoring-emit";
import type { ScoredSlot, LinkParameters } from "@/lib/scoring";

/**
 * Wire-emit derivation tests — `deriveEmittedScore` + `deriveEmittedPreferred`.
 *
 * These are the single source of truth for `slot.score` / `slot.preferred`
 * emitted to MCP consumers and the picker. Per Round 2 MCP review, this file
 * carries the **B3 regression test** that catches the bug class B3 surfaced
 * in Round 1: pinned-as-preference slots must emit `preferred: true` AND
 * `score: -1`, NOT default `preferred: false`.
 *
 * Per proposal `2026-05-01_event-availability-vs-preferred-vs-calendar-
 * scoring`. SPEC #9 invariants preserved:
 *   ≤ -1  — host-preferred / host-pinned-exclusive
 *    0-1  — bookable
 *    2-3  — VIP backup
 *    ≥ 4  — never emitted (filtered earlier)
 */

const tz = "America/Los_Angeles";

function slot(
  start: string,
  end: string,
  score = 0,
  kind: ScoredSlot["kind"] = "open",
): ScoredSlot {
  return {
    start,
    end,
    score,
    confidence: "high",
    reason: "test",
    kind,
    blockCost: "none",
  };
}

const wed9am = slot("2026-05-06T09:00:00-07:00", "2026-05-06T09:30:00-07:00", 0);
const wed7am = slot("2026-05-06T07:00:00-07:00", "2026-05-06T07:30:00-07:00", 3, "off_hours");

describe("deriveEmittedScore — derivation matrix", () => {
  it("path 1: slot in restrictToSlots → -2 (exclusive pin)", () => {
    const rules: LinkParameters = {
      availability: { restrictToSlots: [{ start: wed9am.start, end: wed9am.end }] },
    };
    expect(deriveEmittedScore(wed9am, rules, tz)).toBe(-2);
  });

  it("path 2a: slot in preferred.days → -1", () => {
    const rules: LinkParameters = { preferred: { days: ["Wed"] } };
    expect(deriveEmittedScore(wed9am, rules, tz)).toBe(-1);
  });

  it("path 2b: slot in preferred.windows → -1", () => {
    const rules: LinkParameters = {
      preferred: { windows: [{ start: "08:00", end: "10:00" }] },
    };
    expect(deriveEmittedScore(wed9am, rules, tz)).toBe(-1);
  });

  it("path 2c: slot in preferred.slots → -1", () => {
    const rules: LinkParameters = {
      preferred: { slots: [{ start: wed9am.start, end: wed9am.end }] },
    };
    expect(deriveEmittedScore(wed9am, rules, tz)).toBe(-1);
  });

  it("path 3: expanded off-hours score 2-3 → 0 (host pre-authorized)", () => {
    const rules: LinkParameters = {
      availability: { expand: [{ window: { start: "07:00", end: "10:00" } }] },
    };
    expect(deriveEmittedScore(wed7am, rules, tz)).toBe(0);
  });

  it("path 4 (passthrough): no rule match → unmutated baseScore", () => {
    expect(deriveEmittedScore(wed9am, {}, tz)).toBe(0);
    expect(deriveEmittedScore(wed7am, {}, tz)).toBe(3);
  });

  it("path 4: score-1 bookable slot with no preferred match → 1 (passthrough)", () => {
    const wedScore1 = slot(wed9am.start, wed9am.end, 1);
    expect(deriveEmittedScore(wedScore1, {}, tz)).toBe(1);
  });

  it("path 4: score-4 deep-block slot → 4 (passthrough; expand cannot lift)", () => {
    const wedDeep = slot(wed7am.start, wed7am.end, 4, "off_hours");
    const rules: LinkParameters = {
      availability: { expand: [{ window: { start: "07:00", end: "10:00" } }] },
    };
    // Score >= 4 stays — getTier filters these later.
    expect(deriveEmittedScore(wedDeep, rules, tz)).toBe(4);
  });

  it("precedence: restrictToSlots beats preferred.* even when both match", () => {
    const rules: LinkParameters = {
      availability: { restrictToSlots: [{ start: wed9am.start, end: wed9am.end }] },
      preferred: { days: ["Wed"] },
    };
    expect(deriveEmittedScore(wed9am, rules, tz)).toBe(-2);
  });
});

describe("deriveEmittedPreferred — boolean flag", () => {
  it("false when no preferred or restrictToSlots match", () => {
    expect(deriveEmittedPreferred(wed9am, {}, tz)).toBe(false);
  });

  it("true when slot in preferred.days", () => {
    const rules: LinkParameters = { preferred: { days: ["Wed"] } };
    expect(deriveEmittedPreferred(wed9am, rules, tz)).toBe(true);
  });

  it("true when slot in preferred.windows", () => {
    const rules: LinkParameters = {
      preferred: { windows: [{ start: "08:00", end: "10:00" }] },
    };
    expect(deriveEmittedPreferred(wed9am, rules, tz)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // B3 REGRESSION (the blind-spot Round 1 review surfaced)
  //
  // Today (pre-migration), a slot pinned via `slotOverrides[-1]` emits
  // `preferred: true` because the override mutates the score below -1.
  // Under the new derivation, pinned slots live in `preferred.slots`. If the
  // derivation only reads `preferred.days/.windows`, pinned slots silently
  // emit `preferred: false` — a regression invisible to all other tests.
  //
  // This test is the one specific test that would catch that bug class.
  // -------------------------------------------------------------------------

  it("B3 regression: slot in preferred.slots AND not in days/windows still emits preferred:true", () => {
    const rules: LinkParameters = {
      preferred: {
        // Deliberately leave days/windows empty so the only match path is
        // preferred.slots — the B3 case.
        slots: [{ start: wed9am.start, end: wed9am.end, label: "host pinned" }],
      },
    };
    expect(deriveEmittedPreferred(wed9am, rules, tz)).toBe(true);
    expect(deriveEmittedScore(wed9am, rules, tz)).toBe(-1);
  });

  it("true when slot in restrictToSlots (host-pinned exclusive surfaces as preferred)", () => {
    const rules: LinkParameters = {
      availability: { restrictToSlots: [{ start: wed9am.start, end: wed9am.end }] },
    };
    expect(deriveEmittedPreferred(wed9am, rules, tz)).toBe(true);
  });
});
