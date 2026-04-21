/**
 * Unit tests for the host-intent steering library (proposal 2026-04-21).
 *
 * Scope: the pure-function surface in `lib/intent.ts` — `validateIntent`
 * (§4.6), `deriveLegacy` (§4.2), `hasMaterialNarrowingChange` (§4.7),
 * `readStoredSteering`, `normalizeSteering`. The greeting renderer's
 * `useGenericBody` decision is a single enum read off the output of these
 * functions, so covering them at unit scope gets the refactor's whole
 * behavior under test without spinning up a server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  dateRangeSpanDays,
  deriveLegacy,
  hasExclusiveOverride,
  hasMaterialNarrowingChange,
  hasNarrowingField,
  isSingleSlotExclusive,
  normalizeSteering,
  readStoredSteering,
  validateIntent,
} from "@/lib/intent";

describe("normalizeSteering", () => {
  it("accepts valid values", () => {
    expect(normalizeSteering("open")).toBe("open");
    expect(normalizeSteering("soft")).toBe("soft");
    expect(normalizeSteering("narrow")).toBe("narrow");
    expect(normalizeSteering("exclusive")).toBe("exclusive");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeSteering("OPEN")).toBe("open");
    expect(normalizeSteering("  Soft ")).toBe("soft");
  });

  it("rejects unknowns", () => {
    expect(normalizeSteering("loose")).toBeUndefined();
    expect(normalizeSteering("")).toBeUndefined();
    expect(normalizeSteering(null)).toBeUndefined();
    expect(normalizeSteering(undefined)).toBeUndefined();
    expect(normalizeSteering(42)).toBeUndefined();
  });
});

describe("dateRangeSpanDays", () => {
  it("counts inclusive days", () => {
    expect(dateRangeSpanDays({ dateRange: { start: "2026-04-21", end: "2026-04-21" } })).toBe(1);
    expect(dateRangeSpanDays({ dateRange: { start: "2026-04-21", end: "2026-04-25" } })).toBe(5);
  });

  it("returns Infinity for missing / malformed", () => {
    expect(dateRangeSpanDays(null)).toBe(Infinity);
    expect(dateRangeSpanDays({})).toBe(Infinity);
    expect(dateRangeSpanDays({ dateRange: {} })).toBe(Infinity);
    expect(dateRangeSpanDays({ dateRange: { start: "not-a-date", end: "2026-04-25" } })).toBe(Infinity);
  });
});

describe("hasNarrowingField", () => {
  it("is false for empty rules (open case)", () => {
    expect(hasNarrowingField({})).toBe(false);
    expect(hasNarrowingField(null)).toBe(false);
  });

  it("is false for a wide dateRange alone (PR #57 threshold)", () => {
    expect(hasNarrowingField({ dateRange: { start: "2026-04-21", end: "2026-04-25" } })).toBe(false); // 5 days
    expect(hasNarrowingField({ dateRange: { start: "2026-04-21", end: "2026-05-05" } })).toBe(false); // 15 days
  });

  it("is true for a narrow dateRange (< 5 days)", () => {
    expect(hasNarrowingField({ dateRange: { start: "2026-04-21", end: "2026-04-24" } })).toBe(true); // 4 days
  });

  it("is true when preferred-day or preferred-time fields are set", () => {
    expect(hasNarrowingField({ preferredDays: ["Mon"] })).toBe(true);
    expect(hasNarrowingField({ preferredTimeStart: "09:00" })).toBe(true);
    expect(hasNarrowingField({ preferredTimeEnd: "17:00" })).toBe(true);
    expect(hasNarrowingField({
      preferredTimeWindows: [{ start: "12:00", end: "14:00" }],
    })).toBe(true);
  });

  it("ignores empty arrays", () => {
    expect(hasNarrowingField({ preferredDays: [] })).toBe(false);
    expect(hasNarrowingField({ preferredTimeWindows: [] })).toBe(false);
  });

  it("is true for any slotOverrides entry", () => {
    expect(hasNarrowingField({
      slotOverrides: [{ start: "a", end: "b", score: -1 }],
    })).toBe(true);
  });
});

describe("hasExclusiveOverride", () => {
  it("requires a score === -2 entry", () => {
    expect(hasExclusiveOverride({ slotOverrides: [{ start: "a", end: "b", score: -1 }] })).toBe(false);
    expect(hasExclusiveOverride({ slotOverrides: [{ start: "a", end: "b", score: -2 }] })).toBe(true);
    expect(hasExclusiveOverride({ slotOverrides: [] })).toBe(false);
    expect(hasExclusiveOverride({})).toBe(false);
  });
});

describe("isSingleSlotExclusive", () => {
  it("is true for exactly one slotOverrides[-2] entry", () => {
    expect(
      isSingleSlotExclusive({
        slotOverrides: [
          { start: "2026-04-21T17:15:00-07:00", end: "2026-04-21T19:00:00-07:00", score: -2 },
        ],
      }),
    ).toBe(true);
  });

  it("is true when the single -2 is bracketed by a narrow dateRange / preferredTimeWindows", () => {
    // The Katie case: one -2 slot + bracketing fields. Not multiple offers.
    expect(
      isSingleSlotExclusive({
        dateRange: { start: "2026-04-21", end: "2026-04-21" },
        preferredTimeWindows: [{ start: "17:15", end: "19:00" }],
        slotOverrides: [
          { start: "2026-04-21T17:15:00-07:00", end: "2026-04-21T19:00:00-07:00", score: -2 },
        ],
      }),
    ).toBe(true);
  });

  it("is false for two or more -2 slots (multiple prescriptive offers)", () => {
    expect(
      isSingleSlotExclusive({
        slotOverrides: [
          { start: "a1", end: "a2", score: -2 },
          { start: "b1", end: "b2", score: -2 },
        ],
      }),
    ).toBe(false);
  });

  it("is false with no -2 slots (not exclusive-shaped)", () => {
    expect(
      isSingleSlotExclusive({
        slotOverrides: [{ start: "a", end: "b", score: -1 }],
      }),
    ).toBe(false);
    expect(isSingleSlotExclusive({})).toBe(false);
    expect(isSingleSlotExclusive(null)).toBe(false);
  });

  it("ignores -1 preferred slots alongside a single -2", () => {
    // -1 is a nudge, not an additional offer. Still collapses to single-slot.
    expect(
      isSingleSlotExclusive({
        slotOverrides: [
          { start: "a1", end: "a2", score: -2 },
          { start: "b1", end: "b2", score: -1 },
        ],
      }),
    ).toBe(true);
  });
});

describe("validateIntent (§4.6 asymmetric rule)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("trusts intent when it under-narrows fields (the anytime-next-two-weeks case)", () => {
    // intent=open + wide dateRange is the PRIMARY motivating case. Never step up.
    expect(validateIntent("open", { dateRange: { start: "2026-04-21", end: "2026-05-05" } })).toBe("open");
  });

  it("keeps soft as-is even when fields look empty", () => {
    expect(validateIntent("soft", {})).toBe("soft");
  });

  it("steps narrow → soft when no narrowing field is present", () => {
    expect(validateIntent("narrow", {})).toBe("soft");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("keeps narrow as-is when a narrowing field is present", () => {
    expect(validateIntent("narrow", { preferredDays: ["Tue"] })).toBe("narrow");
    expect(validateIntent("narrow", { dateRange: { start: "2026-04-21", end: "2026-04-23" } })).toBe("narrow");
  });

  it("steps exclusive → narrow when no score-(-2) override exists", () => {
    expect(
      validateIntent("exclusive", {
        slotOverrides: [{ start: "a", end: "b", score: -1 }],
        preferredDays: ["Tue"],
      }),
    ).toBe("narrow");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("cascades exclusive → narrow → soft when no override AND no narrowing field", () => {
    expect(validateIntent("exclusive", {})).toBe("soft");
  });

  it("keeps exclusive when a score-(-2) override is present", () => {
    expect(
      validateIntent("exclusive", {
        slotOverrides: [{ start: "a", end: "b", score: -2 }],
      }),
    ).toBe("exclusive");
  });
});

describe("deriveLegacy (back-compat shim)", () => {
  it("returns open for an empty rules blob", () => {
    expect(deriveLegacy({})).toBe("open");
    expect(deriveLegacy(null)).toBe("open");
  });

  it("returns open for a wide dateRange alone (PR #57)", () => {
    expect(deriveLegacy({ dateRange: { start: "2026-04-21", end: "2026-05-05" } })).toBe("open");
  });

  it("returns narrow when narrowing fields are present", () => {
    expect(deriveLegacy({ preferredDays: ["Tue"] })).toBe("narrow");
    expect(deriveLegacy({ preferredTimeStart: "09:00" })).toBe("narrow");
    expect(deriveLegacy({ dateRange: { start: "2026-04-21", end: "2026-04-23" } })).toBe("narrow");
  });

  it("returns exclusive when a score-(-2) override is present", () => {
    expect(
      deriveLegacy({
        slotOverrides: [{ start: "a", end: "b", score: -2 }],
      }),
    ).toBe("exclusive");
  });
});

describe("readStoredSteering", () => {
  it("reads a valid stored intent", () => {
    expect(readStoredSteering({ intent: { steering: "open" } })).toBe("open");
    expect(readStoredSteering({ intent: { steering: "exclusive" } })).toBe("exclusive");
  });

  it("returns null for missing / malformed", () => {
    expect(readStoredSteering(null)).toBeNull();
    expect(readStoredSteering({})).toBeNull();
    expect(readStoredSteering({ intent: {} })).toBeNull();
    expect(readStoredSteering({ intent: { steering: "bogus" } })).toBeNull();
  });
});

describe("hasMaterialNarrowingChange (§4.7 split rule)", () => {
  it("is false for no-op edits", () => {
    expect(hasMaterialNarrowingChange({}, {})).toBe(false);
    expect(
      hasMaterialNarrowingChange(
        { preferredDays: ["Tue"] },
        { preferredDays: ["Tue"] },
      ),
    ).toBe(false);
  });

  it("flags dateRange collapsing from >=5 days to <5 days", () => {
    expect(
      hasMaterialNarrowingChange(
        { dateRange: { start: "2026-04-21", end: "2026-05-05" } },
        { dateRange: { start: "2026-04-21", end: "2026-04-23" } },
      ),
    ).toBe(true);
  });

  it("does NOT flag a dateRange that stays wide", () => {
    expect(
      hasMaterialNarrowingChange(
        { dateRange: { start: "2026-04-21", end: "2026-05-05" } },
        { dateRange: { start: "2026-04-21", end: "2026-05-12" } },
      ),
    ).toBe(false);
  });

  it("flags preferredTimeStart/End added where none existed", () => {
    expect(hasMaterialNarrowingChange({}, { preferredTimeStart: "09:00" })).toBe(true);
    expect(hasMaterialNarrowingChange({}, { preferredTimeEnd: "17:00" })).toBe(true);
  });

  it("flags preferredDays added where none existed", () => {
    expect(hasMaterialNarrowingChange({}, { preferredDays: ["Tue"] })).toBe(true);
  });

  it("flags preferredTimeWindows added where none existed", () => {
    expect(
      hasMaterialNarrowingChange(
        {},
        { preferredTimeWindows: [{ start: "12:00", end: "14:00" }] },
      ),
    ).toBe(true);
  });

  it("flags adding a score-(-2) slotOverride where none existed", () => {
    expect(
      hasMaterialNarrowingChange(
        {},
        { slotOverrides: [{ start: "a", end: "b", score: -2 }] },
      ),
    ).toBe(true);
  });

  it("does NOT flag trivial field tweaks that preserve the shape", () => {
    // preferredTimeStart already set — changing its value is not a material
    // shape change (still a single-window).
    expect(
      hasMaterialNarrowingChange(
        { preferredTimeStart: "09:00" },
        { preferredTimeStart: "10:00" },
      ),
    ).toBe(false);
  });
});

describe("greeting useGenericBody decision (integration shape)", () => {
  // Documents the single enum read that replaces the 10+ conjunct
  // predicate chain. The actual read happens in `session/route.ts`; this
  // test asserts the mapping is stable so future refactors don't silently
  // flip it.
  const useGenericBody = (steering: ReturnType<typeof deriveLegacy>) =>
    steering === "open" || steering === "soft";

  it("open / soft render the generic body", () => {
    expect(useGenericBody("open")).toBe(true);
    expect(useGenericBody("soft")).toBe(true);
  });

  it("narrow / exclusive render the bulleted body", () => {
    expect(useGenericBody("narrow")).toBe(false);
    expect(useGenericBody("exclusive")).toBe(false);
  });

  it("legacy fallback: wide dateRange alone renders generic body", () => {
    const rules = { dateRange: { start: "2026-04-21", end: "2026-05-05" } };
    expect(useGenericBody(readStoredSteering(rules) ?? deriveLegacy(rules))).toBe(true);
  });

  it("legacy fallback: narrowing field renders bulleted body", () => {
    const rules = { preferredDays: ["Tue"] };
    expect(useGenericBody(readStoredSteering(rules) ?? deriveLegacy(rules))).toBe(false);
  });

  it("stored intent overrides legacy predicate (the whole point)", () => {
    // Rules shape looks like "narrow" to the legacy predicate, but the
    // LLM said it's a bracket — trust intent.
    const rules = {
      preferredDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      dateRange: { start: "2026-04-21", end: "2026-05-05" },
      intent: { steering: "open" as const },
    };
    expect(useGenericBody(readStoredSteering(rules) ?? deriveLegacy(rules))).toBe(true);
  });
});
