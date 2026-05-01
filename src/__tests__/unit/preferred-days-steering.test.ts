import { describe, it, expect } from "vitest";
import { applyEventOverrides, type ScoredSlot, type LinkParameters } from "@/lib/scoring";

/**
 * Tests for the intent-aware `preferredDays` interpretation in
 * `applyEventOverrides`. Bug-driven by feedback `cmon70ahd000g8cbbl2t821jk`
 * (2026-05-01) — host said "any Wednesday" for a coffee link, composer
 * correctly emitted `intent.steering: "narrow"` + `preferredDays: ["Wed"]`,
 * but the picker showed every weekday because the scoring engine had been
 * applying preferredDays as soft-boost regardless of intent since
 * 2026-04-21.
 *
 * The 2026-04-21 fix that introduced the always-soft behavior was
 * legitimate (it addressed Katie link `aeetnc`'s "Wed preferred, Thu/Fri
 * fallback" use case) — it just over-corrected by ignoring `intent.steering`.
 *
 * Current contract:
 *   - intent.steering ∈ {"narrow", "exclusive"} → HARD filter (drop non-prefs)
 *   - intent.steering ∈ {"soft", "open"} or unset → SOFT boost (keep all,
 *                                                   promote prefs to ★)
 *
 * See COMPOSER.md §2 catalogue F10.
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

describe("applyEventOverrides — preferredDays under intent.steering", () => {
  const tz = "America/Los_Angeles";

  // Five weekday slots in early May 2026 — one per weekday, all 9-9:30am PT.
  // We pin to early May to avoid DST-boundary surprises.
  const monSlot = slot("2026-05-04T09:00:00-07:00", "2026-05-04T09:30:00-07:00");
  const tueSlot = slot("2026-05-05T09:00:00-07:00", "2026-05-05T09:30:00-07:00");
  const wedSlot = slot("2026-05-06T09:00:00-07:00", "2026-05-06T09:30:00-07:00");
  const thuSlot = slot("2026-05-07T09:00:00-07:00", "2026-05-07T09:30:00-07:00");
  const friSlot = slot("2026-05-08T09:00:00-07:00", "2026-05-08T09:30:00-07:00");
  const allWeekdays = [monSlot, tueSlot, wedSlot, thuSlot, friSlot];

  // -------------------------------------------------------------------------
  // HARD filter cases — narrow / exclusive intent
  // -------------------------------------------------------------------------

  it("narrow + preferredDays:[Wed] → drops Mon/Tue/Thu/Fri (the F10 repro case)", () => {
    const rules: LinkParameters = {
      intent: { steering: "narrow" },
      preferredDays: ["Wed"],
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(wedSlot.start);
  });

  it("narrow + preferredDays:[Tue, Fri] → keeps only Tue and Fri", () => {
    const rules: LinkParameters = {
      intent: { steering: "narrow" },
      preferredDays: ["Tue", "Fri"],
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out.map((s) => s.start)).toEqual([tueSlot.start, friSlot.start]);
  });

  it("exclusive + preferredDays:[Wed] → also hard-filters", () => {
    // Exclusive normally pairs with slotOverrides:[score:-2]; preferredDays
    // alongside is unusual but if both are set, the day filter applies
    // consistently with narrow.
    const rules: LinkParameters = {
      intent: { steering: "exclusive" },
      preferredDays: ["Wed"],
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(wedSlot.start);
  });

  it("hard filter preserves conflict slots on preferred days (score ≥ 2 unchanged)", () => {
    // A scored conflict on the preferred day shouldn't be dropped — it
    // stays so the picker / scoring downstream can render the conflict
    // signal. The host's day preference can't paper over a real calendar
    // issue, but it shouldn't silently hide it either.
    const wedConflict = slot(wedSlot.start, wedSlot.end, 3);
    const rules: LinkParameters = {
      intent: { steering: "narrow" },
      preferredDays: ["Wed"],
    };
    const out = applyEventOverrides([monSlot, wedConflict, friSlot], rules, tz);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(3);
  });

  it("hard filter on lowercase + long-form day names still filters correctly", () => {
    // normalizeDayName tolerates "wed" / "Wednesday" — the filter must too.
    const rules: LinkParameters = {
      intent: { steering: "narrow" },
      preferredDays: ["Wednesday"],
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out.map((s) => s.start)).toEqual([wedSlot.start]);
  });

  // -------------------------------------------------------------------------
  // SOFT boost cases — soft / open / unset intent (preserves 2026-04-21 fix)
  // -------------------------------------------------------------------------

  it("soft + preferredDays:[Wed] → keeps all days, promotes Wed to ★ tier (score ≤ -1)", () => {
    const rules: LinkParameters = {
      intent: { steering: "soft" },
      preferredDays: ["Wed"],
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(5);
    const wedOut = out.find((s) => s.start === wedSlot.start);
    expect(wedOut?.score).toBeLessThanOrEqual(-1);
    const monOut = out.find((s) => s.start === monSlot.start);
    expect(monOut?.score).toBe(0); // unchanged
  });

  it("open + preferredDays:[Wed] → soft-boost (open intent doesn't hard-narrow)", () => {
    const rules: LinkParameters = {
      intent: { steering: "open" },
      preferredDays: ["Wed"],
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(5);
  });

  it("no intent field + preferredDays:[Wed] → soft-boost (backward compat)", () => {
    // Pre-existing links without `intent` are treated as soft to preserve
    // 2026-04-21 behavior — the always-soft fix was correct for everything
    // EXCEPT the unwired narrow case.
    const rules: LinkParameters = {
      preferredDays: ["Wed"],
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(5);
    const wedOut = out.find((s) => s.start === wedSlot.start);
    expect(wedOut?.score).toBeLessThanOrEqual(-1);
  });

  it("soft + preferredDays:[Wed] does NOT promote conflict slots (score > 1)", () => {
    // Existing soft-boost contract preserved: stretch/conflict on a
    // preferred day stays at its conflict score, doesn't get promoted.
    const wedConflict = slot(wedSlot.start, wedSlot.end, 3);
    const rules: LinkParameters = {
      intent: { steering: "soft" },
      preferredDays: ["Wed"],
    };
    const out = applyEventOverrides([wedConflict, thuSlot], rules, tz);
    const wedOut = out.find((s) => s.start === wedSlot.start);
    expect(wedOut?.score).toBe(3); // not promoted
  });

  // -------------------------------------------------------------------------
  // No-op cases — preferredDays absent or empty
  // -------------------------------------------------------------------------

  it("hard filter with empty preferredDays → no-op", () => {
    const rules: LinkParameters = {
      intent: { steering: "narrow" },
      preferredDays: [],
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(5);
  });

  it("hard filter with preferredDays absent → no-op", () => {
    const rules: LinkParameters = {
      intent: { steering: "narrow" },
    };
    const out = applyEventOverrides(allWeekdays, rules, tz);
    expect(out).toHaveLength(5);
  });
});
