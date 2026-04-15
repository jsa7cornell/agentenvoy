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

// ─── formatAvailabilityWindows — guest timezone dual rendering ──────────────

describe("formatAvailabilityWindows — guest timezone", () => {
  // Slots on 4/15 17:00Z → 10 AM PT → 7 PM CEST
  const slots = run([2026, 4, 15], 17, 0, 4, 1);

  it("renders time range primary in guest TZ with host TZ in parens", () => {
    const out = formatAvailabilityWindows(slots, TZ, NOW, "Europe/Paris");
    expect(out.lines).toHaveLength(1);
    // 10:00 UTC on Apr 15 in Paris is 6 PM CEST (CEST is UTC+2). Primary
    // should be the CEST range, parens should hold the PT range.
    const line = out.lines[0];
    // Primary (CEST range) comes first
    expect(line).toMatch(/7–9 PM/);
    // Host (PT) range in parens
    expect(line).toMatch(/\(10 AM–12 PM/);
    // Short labels: "CEST" and "PT" (or similar native abbreviations)
    expect(line).toMatch(/CEST|CET|GMT/);
    expect(line).toMatch(/PT|PDT|PST/);
  });

  it("groups by guest-local day when guest TZ differs", () => {
    // A slot at 2026-04-15 06:30 UTC falls at:
    //   Host PT: 2026-04-14 23:30 (late night)  → "Tue Apr 14"
    //   Guest CEST: 2026-04-15 08:30 (morning)  → "Wed Apr 15"
    // With guest-local grouping the day label should reference Apr 15.
    const earlyAm = slot([2026, 4, 15], 6, 30, 1);
    const out = formatAvailabilityWindows([earlyAm], TZ, NOW, "Europe/Paris");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("Apr 15");
  });

  it("falls back to single-TZ rendering when guest TZ equals host TZ", () => {
    const out = formatAvailabilityWindows(slots, TZ, NOW, "America/Los_Angeles");
    // Same TZ — should behave identically to no guestTz arg (no parens, no CEST)
    expect(out.lines[0]).not.toContain("(");
    expect(out.lines[0]).not.toContain("CEST");
  });

  it("passing undefined guestTz matches the 3-arg legacy call", () => {
    const a = formatAvailabilityWindows(slots, TZ, NOW);
    const b = formatAvailabilityWindows(slots, TZ, NOW, undefined);
    expect(a.lines).toEqual(b.lines);
    expect(a.hasPreferred).toBe(b.hasPreferred);
  });
});

// ─── humanTimezoneLabel ──────────────────────────────────────────────────────

describe("humanTimezoneLabel", () => {
  it("renders Pacific / Eastern as simplified 'X time'", () => {
    expect(humanTimezoneLabel("America/Los_Angeles")).toBe("Pacific time");
    expect(humanTimezoneLabel("America/New_York")).toBe("Eastern time");
  });

  it("uses the canonical TIMEZONE_TABLE label for zones in the table", () => {
    // Asia/Kolkata is in the table; label is the hand-curated "India time"
    expect(humanTimezoneLabel("Asia/Kolkata")).toBe("India time");
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
