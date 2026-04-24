import { describe, it, expect } from "vitest";
import {
  binSlotsIntoWindows,
  isSparseLayout,
  assertBinningTz,
  type BinningSlot,
  type WindowCard,
} from "@/lib/window-binning";

const TZ = "America/Los_Angeles";

/** Build a slot array from a start hour, count, gap (min), and duration (min). */
function slots(startHour: number, count: number, gapMin: number, durationMin: number, score = 0, date = "2026-04-29"): BinningSlot[] {
  const arr: BinningSlot[] = [];
  for (let i = 0; i < count; i++) {
    const startMin = startHour * 60 + i * gapMin;
    const s = isoAtPT(date, Math.floor(startMin / 60), startMin % 60);
    const e = isoAtPT(date, Math.floor((startMin + durationMin) / 60), (startMin + durationMin) % 60);
    arr.push({ start: s, end: e, score });
  }
  return arr;
}

// PT is UTC-7 during DST (Apr 29). 9:00 PT = 16:00 UTC.
function isoAtPT(dateStr: string, hour: number, minute: number): string {
  const utcHour = hour + 7;
  const dayOffset = Math.floor(utcHour / 24);
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + dayOffset, utcHour % 24, minute, 0));
  return dt.toISOString();
}

describe("binSlotsIntoWindows — Jon/John 3h bike ride", () => {
  it("collapses 13 start-time chips into a small number of named windows", () => {
    // 9:00 AM PT to 3:00 PM PT at 30-min steps, 3h meetings. That's 13 slots.
    // Use score=-1 so slots cross the ★ pick threshold; score=0 slots are
    // offerable but not "preferred" by the host.
    const s = slots(9, 13, 30, 180, -1);
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 180 });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(4);
    expect(cards.some((c) => c.isPick)).toBe(true);
  });

  it("does NOT mark default-score (0) slots as ★ picks", () => {
    // Regression: prior behavior tied isPick to "matches lowest visible score",
    // which made every slot a pick when no preferredDays boost was applied
    // (default score 0 = "best" by tie-breaking, but not actually preferred).
    // ★ is now reserved for score ≤ -1 (explicit host preference).
    const s = slots(9, 6, 30, 60, 0);
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 60 });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((c) => c.isPick)).toBe(false);
  });

  it("at least one card names a day-part when the band is primarily inside one", () => {
    // 9:00–11:30 PT starts, 1h meeting — all-morning band.
    const s = slots(9, 5, 30, 60);
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 60 });
    const names = cards.map((c) => c.name);
    expect(names.some((n) => n === "Morning")).toBe(true);
  });
});

describe("binSlotsIntoWindows — band splitting", () => {
  it("splits >4h bands", () => {
    // 9a–3p PT starts, 1h meetings — 13 slots in one band, 6h span.
    const s = slots(9, 13, 30, 60);
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 60 });
    expect(cards.length).toBeGreaterThanOrEqual(2);
  });

  it("never splits such that a sub-band is shorter than the meeting duration", () => {
    // A 2.5h band with a 2h meeting — can't legally split into two 2h pieces.
    const s = slots(9, 2, 30, 120); // two start times 9:00, 9:30 → band end 11:30
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 120 });
    expect(cards.length).toBe(1);
  });
});

describe("binSlotsIntoWindows — midnight crossing (F7)", () => {
  it("renders a late-evening 3h meeting with no display bug", () => {
    // Offerable starts 9pm PT, 9:30pm PT, 10pm PT, 3h meetings — last end = 1am next day.
    const s = slots(21, 3, 30, 180);
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 180 });
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(new Date(c.end).getTime()).toBeGreaterThan(new Date(c.start).getTime());
      expect(c.name).toBeTruthy();
    }
  });
});

describe("binSlotsIntoWindows — empty / edge", () => {
  it("returns [] for empty input", () => {
    expect(binSlotsIntoWindows([], { tz: TZ, durationMinutes: 60 })).toEqual([]);
  });

  it("drops hidden (score > 1, non-stretch) slots", () => {
    const s: BinningSlot[] = [
      { start: "2026-04-29T16:00:00.000Z", end: "2026-04-29T17:00:00.000Z", score: 3 },
    ];
    expect(binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 60 })).toEqual([]);
  });
});

describe("isSparseLayout (F6)", () => {
  const makeWindows = (n: number): WindowCard[] =>
    Array.from({ length: n }, () => ({
      start: "", end: "", name: "", defaultStart: "", defaultEnd: "", slotCount: 1, isPick: false,
    }));

  it("max=1, days-with-windows=4 → sparse", () => {
    expect(isSparseLayout({
      "d1": makeWindows(1), "d2": makeWindows(1), "d3": makeWindows(1), "d4": makeWindows(1),
    })).toBe(true);
  });

  it("max=1, days-with-windows=2 → dense", () => {
    expect(isSparseLayout({ "d1": makeWindows(1), "d2": makeWindows(1) })).toBe(false);
  });

  it("max=2, days-with-windows=2 → dense", () => {
    expect(isSparseLayout({ "d1": makeWindows(2), "d2": makeWindows(2) })).toBe(false);
  });

  it("empty → dense (separate empty-state render path)", () => {
    expect(isSparseLayout({})).toBe(false);
  });

  it("max=1, days-with-windows=7 → sparse", () => {
    const d: Record<string, WindowCard[]> = {};
    for (let i = 0; i < 7; i++) d[`d${i}`] = makeWindows(1);
    expect(isSparseLayout(d)).toBe(true);
  });
});

describe("binSlotsIntoWindows — multi-day meetings (≥1440 min)", () => {
  it("includes stretch-scored slots (score > 1) for 24h meetings", () => {
    // All slots scored > 1 — would be filtered out for sub-day meetings.
    const s = slots(12, 4, 30, 30, 2); // noon-ish, score=2
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 1440 });
    expect(cards.length).toBeGreaterThan(0);
  });

  it("returns one card per band without sub-day splitting for 24h meetings", () => {
    // 6 consecutive slots (noon–3pm) — should produce 1 card, not 2-3.
    const s = slots(12, 6, 30, 30, 0);
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 1440 });
    expect(cards.length).toBe(1);
  });

  it("returns empty when slot list is empty, even for 24h meetings", () => {
    const cards = binSlotsIntoWindows([], { tz: TZ, durationMinutes: 1440 });
    expect(cards.length).toBe(0);
  });

  it("names the card by time range (not day-part) for a 24h window", () => {
    const s = slots(12, 2, 30, 30, 0);
    const cards = binSlotsIntoWindows(s, { tz: TZ, durationMinutes: 1440 });
    expect(cards[0].name).toMatch(/–/); // time-range format, not "Morning" etc.
  });
});

describe("assertBinningTz (F1)", () => {
  it("passes when tz matches", () => {
    expect(() => assertBinningTz(TZ, TZ)).not.toThrow();
  });

  it("throws in non-production when tz diverges", () => {
    expect(() => assertBinningTz(TZ, "America/New_York")).toThrow(/tz mismatch/);
  });
});
