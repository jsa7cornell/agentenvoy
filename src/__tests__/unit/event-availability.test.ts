import { describe, it, expect } from "vitest";
import {
  computeEventAvailability,
  decorateWithPreferred,
} from "@/lib/event-availability";
import { applyEventOverrides, type ScoredSlot, type LinkParameters } from "@/lib/scoring";

/**
 * Tests for the three-band model:
 *   - calendar availability (per-host) — out of scope here
 *   - event availability (per-link) — `computeEventAvailability` + `applyEventOverrides`
 *   - preferred (per-link, decoration only) — `decorateWithPreferred`
 *
 * The load-bearing invariant: `slot.score` is per-host stable. The pipeline
 * filters slots, but never mutates `slot.score`. This file asserts that
 * directly, plus migrates the F10 + introduces F13 regression fixtures from
 * proposal `2026-05-01_event-availability-vs-preferred-vs-calendar-scoring`.
 *
 * Replaces `preferred-days-steering.test.ts` (deleted same proposal). The
 * F10 matrix is preserved with new field names per the migration table.
 */

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

const tz = "America/Los_Angeles";

// Five weekday slots in early May 2026 — one per weekday, all 9-9:30am PT.
const monSlot = slot("2026-05-04T09:00:00-07:00", "2026-05-04T09:30:00-07:00");
const tueSlot = slot("2026-05-05T09:00:00-07:00", "2026-05-05T09:30:00-07:00");
const wedSlot = slot("2026-05-06T09:00:00-07:00", "2026-05-06T09:30:00-07:00");
const thuSlot = slot("2026-05-07T09:00:00-07:00", "2026-05-07T09:30:00-07:00");
const friSlot = slot("2026-05-08T09:00:00-07:00", "2026-05-08T09:30:00-07:00");
const satSlot = slot("2026-05-09T09:00:00-07:00", "2026-05-09T09:30:00-07:00");
const allWeekdays = [monSlot, tueSlot, wedSlot, thuSlot, friSlot];

// Off-hours Wednesday morning (7am, score 3 / off_hours band — would be
// blocked by hours-protection layer).
const wedEarly = slot(
  "2026-05-06T07:00:00-07:00",
  "2026-05-06T07:30:00-07:00",
  3,
  "off_hours",
);
// Wed 8am — same off-hours treatment.
const wedEarlier = slot(
  "2026-05-06T08:00:00-07:00",
  "2026-05-06T08:30:00-07:00",
  3,
  "off_hours",
);

// ---------------------------------------------------------------------------
// no-mutation invariant — the proposal's load-bearing claim
// ---------------------------------------------------------------------------

describe("computeEventAvailability — no-mutation invariant on slot.score", () => {
  const cases: Array<{ name: string; rules: LinkParameters }> = [
    { name: "empty rules", rules: {} },
    {
      name: "availability.expand only",
      rules: { availability: { expand: [{ window: { start: "07:00", end: "10:00" } }] } },
    },
    {
      name: "availability.restrictToDays only",
      rules: { availability: { restrictToDays: ["Wed"] } },
    },
    {
      name: "preferred.* only",
      rules: { preferred: { days: ["Wed"], windows: [{ start: "14:00", end: "17:00" }] } },
    },
    {
      name: "dateRange + restrict + preferred composed",
      rules: {
        dateRange: { start: "2026-05-04", end: "2026-05-08" },
        availability: { restrictToDays: ["Wed", "Thu"] },
        preferred: { days: ["Wed"] },
      },
    },
  ];

  for (const c of cases) {
    it(`every output slot's score equals input — case: ${c.name}`, () => {
      const input = [...allWeekdays, wedEarly, wedEarlier];
      const out = computeEventAvailability(input, c.rules, tz);
      for (const entry of out) {
        const matchedInput = input.find((s) => s.start === entry.slot.start);
        expect(matchedInput).toBeDefined();
        expect(entry.slot.score).toBe(matchedInput!.score);
      }
    });
  }
});

describe("decorateWithPreferred — no-mutation invariant on slot.score", () => {
  it("every output slot's score equals input regardless of preferred config", () => {
    const set = computeEventAvailability(allWeekdays, {}, tz);
    const decorated = decorateWithPreferred(
      set,
      { preferred: { days: ["Wed"], windows: [{ start: "08:00", end: "10:00" }] } },
      tz,
    );
    for (const entry of decorated) {
      const matched = allWeekdays.find((s) => s.start === entry.slot.start);
      expect(matched).toBeDefined();
      expect(entry.slot.score).toBe(matched!.score);
    }
  });
});

// ---------------------------------------------------------------------------
// F10 migrated — narrow restrict-to-days vs. soft preferred-days
// ---------------------------------------------------------------------------

describe("availability.restrictToDays (replaces preferredDays + narrow steering)", () => {
  it("['Wed'] → drops Mon/Tue/Thu/Fri (the F10 repro case, new field)", () => {
    const rules: LinkParameters = {
      availability: { restrictToDays: ["Wed"] },
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(wedSlot.start);
    // Score unmutated.
    expect(out[0].score).toBe(0);
  });

  it("['Wed','Fri'] → keeps Wed and Fri only", () => {
    const rules: LinkParameters = {
      availability: { restrictToDays: ["Wed", "Fri"] },
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out.map((s) => s.start)).toEqual([wedSlot.start, friSlot.start]);
  });
});

describe("preferred.days (replaces preferredDays + soft steering)", () => {
  it("['Wed'] → keeps every weekday in offerable set; decorates Wed as preferred", () => {
    const rules: LinkParameters = {
      preferred: { days: ["Wed"] },
    };
    const set = computeEventAvailability(allWeekdays, rules, tz);
    const decorated = decorateWithPreferred(set, rules, tz);
    expect(decorated).toHaveLength(5); // all weekdays survive — soft, not hard-filter
    const wed = decorated.find((d) => d.slot.start === wedSlot.start);
    const mon = decorated.find((d) => d.slot.start === monSlot.start);
    expect(wed?.preferred).toBe(true);
    expect(mon?.preferred).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F13 regression — "open up early mornings" must not lop off rest of day
// ---------------------------------------------------------------------------

describe("F13 regression — availability.expand additively widens, never restricts", () => {
  it("expand: 07:00-10:00 keeps both 7am AND 9am Wed slots offerable", () => {
    const rules: LinkParameters = {
      availability: {
        expand: [{ window: { start: "07:00", end: "10:00" } }],
      },
    };
    const input = [wedEarlier, wedSlot]; // 8am off-hours, 9am normal
    const out = applyEventOverrides(input, rules, tz);
    // Both survive — expand is additive, never filters out the rest of day.
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.start).sort()).toEqual(
      [wedEarlier.start, wedSlot.start].sort(),
    );
    // Scores unmutated.
    expect(out.find((s) => s.start === wedEarlier.start)?.score).toBe(3);
    expect(out.find((s) => s.start === wedSlot.start)?.score).toBe(0);
  });

  it("computeEventAvailability marks expanded:true for slot inside expand window", () => {
    const rules: LinkParameters = {
      availability: {
        expand: [{ window: { start: "07:00", end: "10:00" } }],
      },
    };
    const set = computeEventAvailability([wedEarlier, wedSlot], rules, tz);
    expect(set.find((e) => e.slot.start === wedEarlier.start)?.expanded).toBe(true);
    expect(set.find((e) => e.slot.start === wedSlot.start)?.expanded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allowWeekends → availability.expand: [{days: [Sat,Sun]}]
// ---------------------------------------------------------------------------

describe("availability.expand days (replaces allowWeekends boolean)", () => {
  it("expand days:[Sat] keeps Sat slot in result; non-weekend slots also kept", () => {
    const rules: LinkParameters = {
      availability: { expand: [{ days: ["Sat"] }] },
    };
    const out = applyEventOverrides([wedSlot, satSlot], rules, tz);
    expect(out).toHaveLength(2);
    const set = computeEventAvailability([wedSlot, satSlot], rules, tz);
    expect(set.find((e) => e.slot.start === satSlot.start)?.expanded).toBe(true);
    expect(set.find((e) => e.slot.start === wedSlot.start)?.expanded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Restriction composition — restrictToDays AND restrictToWindows AND restrictToSlots
// ---------------------------------------------------------------------------

describe("availability.restrictTo* composition (intersection)", () => {
  it("restrictToDays + restrictToWindows = AND-intersected", () => {
    // Wed only, 8-9am window only.
    const rules: LinkParameters = {
      availability: {
        restrictToDays: ["Wed"],
        restrictToWindows: [{ start: "08:00", end: "09:00" }],
      },
    };
    const input = [monSlot, tueSlot, wedEarlier, wedSlot, thuSlot];
    const out = applyEventOverrides(input, rules, tz);
    // Only wedEarlier (Wed 8am) survives.
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(wedEarlier.start);
  });

  it("restrictToSlots — only listed instances survive", () => {
    const rules: LinkParameters = {
      availability: {
        restrictToSlots: [{ start: wedSlot.start, end: wedSlot.end }],
      },
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(wedSlot.start);
  });
});

// ---------------------------------------------------------------------------
// availability.blockedSlots — named singular slot exclusions
// ---------------------------------------------------------------------------

describe("availability.blockedSlots (replaces slotOverrides[score: 5])", () => {
  it("excludes the named slot but keeps everything else", () => {
    const rules: LinkParameters = {
      availability: {
        blockedSlots: [{ start: wedSlot.start, end: wedSlot.end }],
      },
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(4);
    expect(out.find((s) => s.start === wedSlot.start)).toBeUndefined();
  });
});
