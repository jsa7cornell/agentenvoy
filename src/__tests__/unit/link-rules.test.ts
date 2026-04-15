import { describe, it, expect } from "vitest";
import {
  normalizeDayName,
  normalizeLinkRules,
  applyEventOverrides,
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
