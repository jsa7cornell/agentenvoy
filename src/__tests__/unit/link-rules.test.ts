import { describe, it, expect } from "vitest";
import {
  normalizeDayName,
  normalizeLinkRules,
  applyEventOverrides,
  getTimeWindows,
  type ScoredSlot,
  type LinkRules,
} from "@/lib/scoring";

// ─── normalizeDayName ────────────────────────────────────────────────────────

describe("normalizeDayName", () => {
  it("returns canonical short form for long names", () => {
    expect(normalizeDayName("Monday")).toBe("Mon");
    expect(normalizeDayName("Tuesday")).toBe("Tue");
    expect(normalizeDayName("Sunday")).toBe("Sun");
  });

  it("returns canonical short form for short names", () => {
    expect(normalizeDayName("Mon")).toBe("Mon");
    expect(normalizeDayName("Fri")).toBe("Fri");
  });

  it("is case-insensitive", () => {
    expect(normalizeDayName("monday")).toBe("Mon");
    expect(normalizeDayName("MON")).toBe("Mon");
    expect(normalizeDayName("tUe")).toBe("Tue");
  });

  it("trims whitespace", () => {
    expect(normalizeDayName("  Wed  ")).toBe("Wed");
  });

  it("rejects garbage", () => {
    expect(normalizeDayName("")).toBeNull();
    expect(normalizeDayName("Funday")).toBeNull();
    expect(normalizeDayName(null)).toBeNull();
    expect(normalizeDayName(undefined)).toBeNull();
    expect(normalizeDayName(42)).toBeNull();
  });
});

// ─── normalizeLinkRules ──────────────────────────────────────────────────────

describe("normalizeLinkRules", () => {
  it("coerces long day names to short form", () => {
    const out = normalizeLinkRules({
      preferredDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    });
    expect(out.preferredDays).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  });

  it("passes short day names through unchanged", () => {
    const out = normalizeLinkRules({
      preferredDays: ["Mon", "Tue"],
      lastResort: ["Fri"],
    });
    expect(out.preferredDays).toEqual(["Mon", "Tue"]);
    expect(out.lastResort).toEqual(["Fri"]);
  });

  it("drops garbage day names", () => {
    const out = normalizeLinkRules({
      preferredDays: ["Monday", "Funday", "", null, "Tue"],
    });
    expect(out.preferredDays).toEqual(["Mon", "Tue"]);
  });

  it("de-dupes days", () => {
    const out = normalizeLinkRules({
      preferredDays: ["Mon", "Monday", "MON", "mon"],
    });
    expect(out.preferredDays).toEqual(["Mon"]);
  });

  it("preserves unknown keys unchanged", () => {
    const out = normalizeLinkRules({
      format: "video",
      duration: 30,
      notes: "hello",
    });
    expect(out).toEqual({ format: "video", duration: 30, notes: "hello" });
  });

  it("keeps valid dateRange", () => {
    const out = normalizeLinkRules({
      dateRange: { start: "2026-04-20", end: "2026-04-24" },
    });
    expect(out.dateRange).toEqual({ start: "2026-04-20", end: "2026-04-24" });
  });

  it("drops malformed dateRange", () => {
    const out = normalizeLinkRules({
      dateRange: { start: "tomorrow", end: "next week" },
    });
    expect(out.dateRange).toBeUndefined();
  });

  it("keeps dateRange with only one end", () => {
    const out = normalizeLinkRules({
      dateRange: { start: "2026-04-20" },
    });
    expect(out.dateRange).toEqual({ start: "2026-04-20" });
  });

  it("handles null/undefined/non-object input", () => {
    expect(normalizeLinkRules(null)).toEqual({});
    expect(normalizeLinkRules(undefined)).toEqual({});
  });
});

// ─── applyEventOverrides — preferredDays ─────────────────────────────────────

/** Build a ScoredSlot for a given ISO datetime. */
function slot(iso: string, score = 0): ScoredSlot {
  const start = new Date(iso);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    score,
    confidence: "high",
    reason: "open",
  };
}

describe("applyEventOverrides — preferredDays", () => {
  // 2026-04-20 is a Monday (Apr 14 2026 was a Tuesday).
  const monday9pdt = "2026-04-20T16:00:00.000Z"; // 9 AM PDT
  const tuesday9pdt = "2026-04-21T16:00:00.000Z";
  const wednesday9pdt = "2026-04-22T16:00:00.000Z";
  const saturday9pdt = "2026-04-18T16:00:00.000Z";

  const base = [
    slot(monday9pdt),
    slot(tuesday9pdt),
    slot(wednesday9pdt),
    slot(saturday9pdt),
  ];

  it("keeps weekdays and drops weekends with short day names", () => {
    const rules: LinkRules = { preferredDays: ["Mon", "Tue", "Wed", "Thu", "Fri"] };
    const out = applyEventOverrides(base, rules, "America/Los_Angeles");
    expect(out.map((s) => s.start)).toEqual([monday9pdt, tuesday9pdt, wednesday9pdt]);
  });

  it("tolerates long day names at read time (back-compat)", () => {
    const rules: LinkRules = {
      preferredDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    };
    const out = applyEventOverrides(base, rules, "America/Los_Angeles");
    expect(out.map((s) => s.start)).toEqual([monday9pdt, tuesday9pdt, wednesday9pdt]);
  });

  it("tolerates mixed day name shapes", () => {
    const rules: LinkRules = { preferredDays: ["Mon", "tuesday", "WED"] };
    const out = applyEventOverrides(base, rules, "America/Los_Angeles");
    expect(out.map((s) => s.start)).toEqual([monday9pdt, tuesday9pdt, wednesday9pdt]);
  });
});

// ─── applyEventOverrides — dateRange ─────────────────────────────────────────

describe("applyEventOverrides — dateRange", () => {
  // Use times deep inside each PT day to avoid midnight-boundary confusion.
  const apr19 = "2026-04-19T18:00:00.000Z"; // Sun Apr 19 11 AM PDT
  const apr20 = "2026-04-20T18:00:00.000Z"; // Mon
  const apr22 = "2026-04-22T18:00:00.000Z"; // Wed
  const apr24 = "2026-04-24T18:00:00.000Z"; // Fri
  const apr25 = "2026-04-25T18:00:00.000Z"; // Sat (outside)

  const base = [slot(apr19), slot(apr20), slot(apr22), slot(apr24), slot(apr25)];

  it("filters to inclusive [start, end] window in host tz", () => {
    const rules: LinkRules = { dateRange: { start: "2026-04-20", end: "2026-04-24" } };
    const out = applyEventOverrides(base, rules, "America/Los_Angeles");
    expect(out.map((s) => s.start)).toEqual([apr20, apr22, apr24]);
  });

  it("applies only start when end is omitted", () => {
    const rules: LinkRules = { dateRange: { start: "2026-04-22" } };
    const out = applyEventOverrides(base, rules, "America/Los_Angeles");
    expect(out.map((s) => s.start)).toEqual([apr22, apr24, apr25]);
  });

  it("applies only end when start is omitted", () => {
    const rules: LinkRules = { dateRange: { end: "2026-04-20" } };
    const out = applyEventOverrides(base, rules, "America/Los_Angeles");
    expect(out.map((s) => s.start)).toEqual([apr19, apr20]);
  });
});

// ─── Regression: eyajs5 reproduction ─────────────────────────────────────────

describe("regression — eyajs5 preferredDays shape", () => {
  it("filter no longer nukes every slot when short names are persisted", () => {
    // This is the exact rules shape that caused Bryan's deal room to see
    // "no offerable times" after the greeting showed plenty.
    const rules: LinkRules = {
      format: "video",
      preferredDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      dateRange: { start: "2026-04-20", end: "2026-04-24" },
    };
    const input = [
      slot("2026-04-20T17:00:00.000Z"), // Mon 10 AM PDT
      slot("2026-04-21T17:00:00.000Z"), // Tue 10 AM PDT
      slot("2026-04-25T17:00:00.000Z"), // Sat 10 AM PDT (out of range)
    ];
    const out = applyEventOverrides(input, rules, "America/Los_Angeles");
    expect(out.length).toBe(2);
  });
});

// ─── preferredTimeWindows ────────────────────────────────────────────────────

describe("preferredTimeWindows normalization", () => {
  it("keeps well-formed windows and sorts them by start", () => {
    const out = normalizeLinkRules({
      preferredTimeWindows: [
        { start: "16:30", end: "18:00" },
        { start: "12:00", end: "14:00" },
      ],
    });
    expect(out.preferredTimeWindows).toEqual([
      { start: "12:00", end: "14:00" },
      { start: "16:30", end: "18:00" },
    ]);
  });

  it("accepts 24:00 as an end-of-day sentinel", () => {
    const out = normalizeLinkRules({
      preferredTimeWindows: [{ start: "20:00", end: "24:00" }],
    });
    expect(out.preferredTimeWindows).toEqual([{ start: "20:00", end: "24:00" }]);
  });

  it("drops entries with bad shape, non-HH:MM strings, or start >= end", () => {
    const out = normalizeLinkRules({
      preferredTimeWindows: [
        { start: "12:00", end: "14:00" }, // good
        { start: "25:00", end: "26:00" }, // bad hour
        { start: "12:60", end: "13:00" }, // bad minute
        { start: "14:00", end: "12:00" }, // inverted
        { start: "14:00", end: "14:00" }, // empty span
        "not-an-object",
        { start: 12, end: 14 },          // wrong types
      ] as unknown as Array<{ start: string; end: string }>,
    });
    expect(out.preferredTimeWindows).toEqual([{ start: "12:00", end: "14:00" }]);
  });

  it("drops the field entirely when the array is non-array or cleans to empty", () => {
    expect(normalizeLinkRules({ preferredTimeWindows: "oops" }).preferredTimeWindows).toBeUndefined();
    expect(normalizeLinkRules({ preferredTimeWindows: [] }).preferredTimeWindows).toBeUndefined();
    expect(
      normalizeLinkRules({
        preferredTimeWindows: [{ start: "x", end: "y" }],
      }).preferredTimeWindows,
    ).toBeUndefined();
  });
});

describe("getTimeWindows precedence", () => {
  it("returns the multi-window array when present and non-empty", () => {
    const rules: LinkRules = {
      preferredTimeStart: "09:00",
      preferredTimeEnd: "17:00",
      preferredTimeWindows: [
        { start: "12:00", end: "14:00" },
        { start: "16:30", end: "18:00" },
      ],
    };
    expect(getTimeWindows(rules)).toEqual([
      { start: "12:00", end: "14:00" },
      { start: "16:30", end: "18:00" },
    ]);
  });

  it("falls back to single-window pair when the array is absent", () => {
    expect(
      getTimeWindows({ preferredTimeStart: "09:00", preferredTimeEnd: "12:00" }),
    ).toEqual([{ start: "09:00", end: "12:00" }]);
  });

  it("fills 00:00 / 24:00 when only one end of the single window is set", () => {
    expect(getTimeWindows({ preferredTimeStart: "09:00" })).toEqual([
      { start: "09:00", end: "24:00" },
    ]);
    expect(getTimeWindows({ preferredTimeEnd: "17:00" })).toEqual([
      { start: "00:00", end: "17:00" },
    ]);
  });

  it("returns [] when no window is set at all", () => {
    expect(getTimeWindows({})).toEqual([]);
  });
});

describe("applyEventOverrides filters on multi-window", () => {
  const slot = (iso: string, duration = 30): ScoredSlot => ({
    start: iso,
    end: new Date(new Date(iso).getTime() + duration * 60_000).toISOString(),
    score: 1,
    reason: "biz hours",
    kind: "open",
    confidence: "high",
    blockCost: "none",
    firmness: "weak",
  });

  it("keeps slots inside ANY window and drops the gap between them", () => {
    // All slots on Mon Apr 20, America/Los_Angeles (UTC-7 during PDT).
    // 12:00 PDT = 19:00 UTC, 15:00 PDT = 22:00 UTC, 17:00 PDT = 00:00 UTC (+1d)
    const rules: LinkRules = {
      preferredTimeWindows: [
        { start: "12:00", end: "14:00" },
        { start: "16:30", end: "18:00" },
      ],
      dateRange: { start: "2026-04-20", end: "2026-04-20" },
    };
    const input = [
      slot("2026-04-20T19:00:00.000Z"), // 12:00 PDT — in window 1
      slot("2026-04-20T22:00:00.000Z"), // 15:00 PDT — between windows (gap)
      slot("2026-04-21T00:00:00.000Z"), // 17:00 PDT — in window 2
      slot("2026-04-21T02:00:00.000Z"), // 19:00 PDT — after both
    ];
    const out = applyEventOverrides(input, rules, "America/Los_Angeles");
    const hours = out.map((s) => new Date(s.start).toISOString()).sort();
    expect(hours).toEqual([
      "2026-04-20T19:00:00.000Z",
      "2026-04-21T00:00:00.000Z",
    ]);
  });
});
