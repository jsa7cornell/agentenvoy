import { describe, it, expect } from "vitest";
import {
  formatAvailabilityWindows,
  humanTimezoneLabel,
  formatLabel,
  alternateFormatsLabel,
} from "@/lib/greeting-template";
import type { ScoredSlot } from "@/lib/scoring";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a ScoredSlot for a given UTC date/hour/minute offset.
 * Tests pin `now` and use a fixed base date so results are deterministic.
 */
function slot(
  baseUtcYmd: [number, number, number],
  hour: number,
  minute: number,
  score: number
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

/** Build N consecutive 30-min slots at a given score. */
function run(
  baseUtcYmd: [number, number, number],
  startHour: number,
  startMinute: number,
  count: number,
  score: number
): ScoredSlot[] {
  const slots: ScoredSlot[] = [];
  for (let i = 0; i < count; i++) {
    const total = startHour * 60 + startMinute + i * 30;
    slots.push(slot(baseUtcYmd, Math.floor(total / 60), total % 60, score));
  }
  return slots;
}

// Fixed "now" far before any of the test slots so everything is in the future.
// UTC baseline: 2026-04-14 00:00Z — Pacific time is 2026-04-13 17:00 PDT.
const NOW = new Date(Date.UTC(2026, 3, 14, 0, 0));
const TZ = "America/Los_Angeles";

// ─── formatAvailabilityWindows ───────────────────────────────────────────────

describe("formatAvailabilityWindows", () => {
  it("collapses contiguous 30-min slots into a single range", () => {
    // Four 30-min slots on 4/15: 10:00, 10:30, 11:00, 11:30 PT (UTC 17:00–19:00)
    const slots = run([2026, 4, 15], 17, 0, 4, 1);
    const out = formatAvailabilityWindows(slots, TZ, NOW);
    expect(out.lines).toHaveLength(1);
    // Exactly one range, not four bullets
    expect(out.lines[0]).toContain("10 AM–12 PM");
    expect(out.hasPreferred).toBe(false);
  });

  it("marks a range containing a preferred slot with ★", () => {
    // Three slots; the middle one is preferred (score -1)
    const slots = [
      ...run([2026, 4, 15], 17, 0, 1, 1),
      ...run([2026, 4, 15], 17, 30, 1, -1),
      ...run([2026, 4, 15], 18, 0, 1, 1),
    ];
    const out = formatAvailabilityWindows(slots, TZ, NOW);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("★");
    expect(out.hasPreferred).toBe(true);
  });

  it("splits a block wider than ~3 hours (no '10 AM–6 PM' output)", () => {
    // Eight contiguous slots = 4 hours starting 10 AM PT → should be truncated
    // to a single ≤3h window, never "10 AM–2 PM" + nothing beyond, and
    // definitely never the full 4h run.
    const slots = run([2026, 4, 15], 17, 0, 8, 1); // 10:00–14:00 PT
    const out = formatAvailabilityWindows(slots, TZ, NOW);
    expect(out.lines).toHaveLength(1);
    // Must not output the full 4-hour range
    expect(out.lines[0]).not.toContain("10 AM–2 PM");
    // Must output a ≤3h window starting at 10 AM
    expect(out.lines[0]).toContain("10 AM–1 PM");
  });

  it("caps output at 5 days", () => {
    // Seven days, each with a single 30-min open slot at 10 AM PT.
    const slots: ScoredSlot[] = [];
    for (let day = 15; day <= 21; day++) {
      slots.push(...run([2026, 4, day], 17, 0, 1, 1));
    }
    const out = formatAvailabilityWindows(slots, TZ, NOW);
    expect(out.lines).toHaveLength(5);
  });

  it("prioritizes days with preferred slots when trimming to the 5-day cap", () => {
    // 6 days of open slots. Day 20 has the only preferred slot.
    // It must appear in the output even though there are 5 earlier days.
    const slots: ScoredSlot[] = [];
    for (let day = 15; day <= 19; day++) {
      slots.push(...run([2026, 4, day], 17, 0, 1, 1));
    }
    slots.push(...run([2026, 4, 20], 17, 0, 1, -1)); // preferred
    const out = formatAvailabilityWindows(slots, TZ, NOW);
    expect(out.lines).toHaveLength(5);
    expect(out.hasPreferred).toBe(true);
    const joined = out.lines.join("\n");
    expect(joined).toContain("Apr 20");
    expect(joined).toContain("★");
  });

  it("returns empty lines + hasPreferred=false when there are no offerable slots", () => {
    const out = formatAvailabilityWindows([], TZ, NOW);
    expect(out.lines).toEqual([]);
    expect(out.hasPreferred).toBe(false);
  });
});

// ─── humanTimezoneLabel ──────────────────────────────────────────────────────

describe("humanTimezoneLabel", () => {
  it("renders Pacific / Eastern as simplified 'X time'", () => {
    expect(humanTimezoneLabel("America/Los_Angeles")).toBe("Pacific time");
    expect(humanTimezoneLabel("America/New_York")).toBe("Eastern time");
  });

  it("keeps non-US zones in their full long form", () => {
    // India has no DST — stays as "India Standard Time"
    expect(humanTimezoneLabel("Asia/Kolkata")).toBe("India Standard Time");
  });

  it("never returns a raw UTC offset", () => {
    const label = humanTimezoneLabel("America/Los_Angeles");
    expect(label).not.toMatch(/GMT[+-]/);
    expect(label).not.toMatch(/UTC[+-]/);
  });
});

// ─── format label helpers ────────────────────────────────────────────────────

describe("formatLabel", () => {
  it("maps known formats", () => {
    expect(formatLabel("video")).toBe("video call");
    expect(formatLabel("phone")).toBe("phone call");
    expect(formatLabel("in-person")).toBe("in-person meeting");
  });
  it("returns null for undefined", () => {
    expect(formatLabel(undefined)).toBeNull();
  });
});

describe("alternateFormatsLabel", () => {
  it("describes remaining formats", () => {
    expect(alternateFormatsLabel("video")).toBe("a call or in-person");
    expect(alternateFormatsLabel("phone")).toBe("video or in-person");
    expect(alternateFormatsLabel("in-person")).toBe("phone or video");
  });
});
