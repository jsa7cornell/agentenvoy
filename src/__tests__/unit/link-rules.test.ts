import { describe, it, expect } from "vitest";
import {
  normalizeDayName,
  normalizeLinkParameters,
  type LinkParameters,
} from "@/lib/scoring";

/**
 * Surviving tests after the 2026-05-01 schema rewrite (proposal:
 * `event-availability-vs-preferred-vs-calendar-scoring`).
 *
 * Removed (covered by event-availability.test.ts now):
 *   - applyEventOverrides + preferredDays
 *   - applyEventOverrides + preferredTimeStart/End/Windows
 *   - applyEventOverrides + slotOverrides
 *   - applyEventOverrides + allowWeekends
 *   - getTimeWindows (helper deleted)
 *
 * Kept here:
 *   - normalizeDayName
 *   - normalizeLinkParameters orthogonal fields (lastResort, dateRange,
 *     guestGuidance.preferredFormat, format, duration, etc.)
 */

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

// ─── normalizeLinkParameters — surviving fields only ─────────────────────────

describe("normalizeLinkParameters", () => {
  it("coerces lastResort long day names to short form", () => {
    const out = normalizeLinkParameters({
      lastResort: ["Monday", "Friday"],
    });
    expect(out.lastResort).toEqual(["Mon", "Fri"]);
  });

  it("drops garbage day names from lastResort", () => {
    const out = normalizeLinkParameters({
      lastResort: ["Monday", "Funday", "", null, "Tue"],
    });
    expect(out.lastResort).toEqual(["Mon", "Tue"]);
  });

  it("strips removed legacy fields (preferredDays, preferredTimeStart/End/Windows, allowWeekends, slotOverrides, exclusiveSlots)", () => {
    // Per the 2026-05-01 hard cut: any legacy fields in the input are dropped
    // by `normalizeLinkParameters`. Downstream Zod parse also catches these
    // via `.passthrough()` not surfacing the typed shape.
    const out = normalizeLinkParameters({
      preferredDays: ["Mon"],
      preferredTimeStart: "07:00",
      preferredTimeEnd: "10:00",
      preferredTimeWindows: [{ start: "08:00", end: "10:00" }],
      allowWeekends: true,
      slotOverrides: [{ start: "x", end: "y", score: -2 }],
      exclusiveSlots: true,
      // Orthogonal fields preserved.
      format: "video",
      duration: 30,
    });
    expect(out.preferredDays).toBeUndefined();
    expect(out.preferredTimeStart).toBeUndefined();
    expect(out.preferredTimeEnd).toBeUndefined();
    expect(out.preferredTimeWindows).toBeUndefined();
    expect(out.allowWeekends).toBeUndefined();
    expect(out.slotOverrides).toBeUndefined();
    expect(out.exclusiveSlots).toBeUndefined();
    expect(out.format).toBe("video");
    expect(out.duration).toBe(30);
  });

  it("preserves unknown keys unchanged", () => {
    const out = normalizeLinkParameters({
      format: "video",
      duration: 30,
      notes: "hello",
    });
    expect(out).toEqual({ format: "video", duration: 30, notes: "hello" });
  });

  it("keeps valid dateRange", () => {
    const out = normalizeLinkParameters({
      dateRange: { start: "2026-04-20", end: "2026-04-24" },
    });
    expect(out.dateRange).toEqual({ start: "2026-04-20", end: "2026-04-24" });
  });

  it("drops malformed dateRange", () => {
    const out = normalizeLinkParameters({
      dateRange: { start: "tomorrow", end: "next week" },
    });
    expect(out.dateRange).toBeUndefined();
  });

  it("keeps dateRange with only one end", () => {
    const out = normalizeLinkParameters({
      dateRange: { start: "2026-04-20" },
    });
    expect(out.dateRange).toEqual({ start: "2026-04-20" });
  });

  it("handles null/undefined/non-object input", () => {
    expect(normalizeLinkParameters(null)).toEqual({});
    expect(normalizeLinkParameters(undefined)).toEqual({});
  });

  // ─── guestGuidance.preferredFormat (envelope-preferred 2026-04-20) ─────────

  it("preserves guestGuidance.preferredFormat: 'video'", () => {
    const out = normalizeLinkParameters({
      guestGuidance: { preferredFormat: "video" },
    }) as LinkParameters;
    expect(out.guestGuidance?.preferredFormat).toBe("video");
  });

  it("preserves guestGuidance.preferredFormat: 'in-person'", () => {
    const out = normalizeLinkParameters({
      guestGuidance: { preferredFormat: "in-person" },
    }) as LinkParameters;
    expect(out.guestGuidance?.preferredFormat).toBe("in-person");
  });

  it("drops 'in_person' (underscore — common LLM typo)", () => {
    const out = normalizeLinkParameters({
      guestGuidance: { preferredFormat: "in_person" as unknown as "in-person" },
    }) as LinkParameters;
    expect(out.guestGuidance?.preferredFormat).toBeUndefined();
  });

  it("drops bogus preferredFormat values", () => {
    const out = normalizeLinkParameters({
      guestGuidance: { preferredFormat: "telepathy" as unknown as "video" },
    }) as LinkParameters;
    expect(out.guestGuidance?.preferredFormat).toBeUndefined();
  });

  it("preferredFormat co-exists with other guestGuidance keys", () => {
    const out = normalizeLinkParameters({
      guestGuidance: {
        suggestions: { locations: ["Ritual"], durations: [30] },
        tone: "friendly",
        preferredFormat: "video",
      },
    }) as LinkParameters;
    expect(out.guestGuidance).toEqual({
      suggestions: { locations: ["Ritual"], durations: [30] },
      tone: "friendly",
      preferredFormat: "video",
    });
  });
});
