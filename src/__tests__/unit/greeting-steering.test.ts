/**
 * Unit tests for the host-intent steering library (proposal 2026-04-21,
 * with 2026-05-01 schema migration).
 *
 * Scope: pure-function surface in `lib/intent.ts` — `validateIntent` (§4.6),
 * `deriveLegacy` (§4.2), `hasMaterialNarrowingChange` (§4.7),
 * `readStoredSteering`, `normalizeSteering`. After the 2026-05-01 schema
 * rewrite, the narrowing-field detection reads `availability.restrictTo*`
 * and `preferred.*` instead of the legacy `preferredDays`,
 * `preferredTimeStart/End`, `preferredTimeWindows`, `slotOverrides` fields.
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

describe("hasNarrowingField (post-2026-05-01 schema)", () => {
  it("is false for empty rules (open case)", () => {
    expect(hasNarrowingField({})).toBe(false);
    expect(hasNarrowingField(null)).toBe(false);
  });

  it("is false for a wide dateRange alone (5+ days)", () => {
    expect(hasNarrowingField({ dateRange: { start: "2026-04-21", end: "2026-04-25" } })).toBe(false); // 5 days
    expect(hasNarrowingField({ dateRange: { start: "2026-04-21", end: "2026-05-05" } })).toBe(false); // 15 days
  });

  it("is true for a narrow dateRange (< 5 days)", () => {
    expect(hasNarrowingField({ dateRange: { start: "2026-04-21", end: "2026-04-24" } })).toBe(true);
  });

  it("is true when availability.restrictTo* fields are set", () => {
    expect(hasNarrowingField({ availability: { restrictToDays: ["Mon"] } })).toBe(true);
    expect(hasNarrowingField({ availability: { restrictToWindows: [{ start: "12:00", end: "14:00" }] } })).toBe(true);
    expect(hasNarrowingField({ availability: { restrictToSlots: [{ start: "x", end: "y" }] } })).toBe(true);
  });

  it("is true when preferred.* fields are set", () => {
    expect(hasNarrowingField({ preferred: { days: ["Mon"] } })).toBe(true);
    expect(hasNarrowingField({ preferred: { windows: [{ start: "12:00", end: "14:00" }] } })).toBe(true);
    expect(hasNarrowingField({ preferred: { slots: [{ start: "x", end: "y" }] } })).toBe(true);
  });

  it("ignores empty arrays", () => {
    expect(hasNarrowingField({ availability: { restrictToDays: [] } })).toBe(false);
    expect(hasNarrowingField({ preferred: { days: [] } })).toBe(false);
  });
});

describe("hasExclusiveOverride", () => {
  it("requires availability.restrictToSlots to have at least one entry", () => {
    expect(hasExclusiveOverride({ availability: { restrictToSlots: [{ start: "a", end: "b" }] } })).toBe(true);
    expect(hasExclusiveOverride({ availability: { restrictToSlots: [] } })).toBe(false);
    expect(hasExclusiveOverride({ availability: {} })).toBe(false);
    expect(hasExclusiveOverride({})).toBe(false);
  });

  it("returns false when only preferred.slots (-1 equivalent) is set", () => {
    expect(hasExclusiveOverride({ preferred: { slots: [{ start: "a", end: "b" }] } })).toBe(false);
  });
});

describe("isSingleSlotExclusive", () => {
  it("is true for exactly one availability.restrictToSlots entry", () => {
    expect(
      isSingleSlotExclusive({
        availability: {
          restrictToSlots: [
            { start: "2026-04-21T17:15:00-07:00", end: "2026-04-21T19:00:00-07:00" },
          ],
        },
      }),
    ).toBe(true);
  });

  it("is true when the single restrictToSlots is bracketed by a narrow dateRange / restrictToWindows", () => {
    // The Katie case: one pinned slot + bracketing fields. Not multiple offers.
    expect(
      isSingleSlotExclusive({
        dateRange: { start: "2026-04-21", end: "2026-04-21" },
        availability: {
          restrictToWindows: [{ start: "17:15", end: "19:00" }],
          restrictToSlots: [
            { start: "2026-04-21T17:15:00-07:00", end: "2026-04-21T19:00:00-07:00" },
          ],
        },
      }),
    ).toBe(true);
  });

  it("is false for two or more restrictToSlots entries (multiple prescriptive offers)", () => {
    expect(
      isSingleSlotExclusive({
        availability: {
          restrictToSlots: [
            { start: "a1", end: "a2" },
            { start: "b1", end: "b2" },
          ],
        },
      }),
    ).toBe(false);
  });

  it("is false with no restrictToSlots (not exclusive-shaped)", () => {
    expect(isSingleSlotExclusive({ preferred: { slots: [{ start: "a", end: "b" }] } })).toBe(false);
    expect(isSingleSlotExclusive({})).toBe(false);
    expect(isSingleSlotExclusive(null)).toBe(false);
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
    expect(validateIntent("narrow", { availability: { restrictToDays: ["Tue"] } })).toBe("narrow");
    expect(validateIntent("narrow", { preferred: { days: ["Tue"] } })).toBe("narrow");
    expect(validateIntent("narrow", { dateRange: { start: "2026-04-21", end: "2026-04-23" } })).toBe("narrow");
  });

  it("steps exclusive → narrow when no availability.restrictToSlots exists", () => {
    expect(
      validateIntent("exclusive", {
        preferred: { slots: [{ start: "a", end: "b" }] },
        availability: { restrictToDays: ["Tue"] },
      }),
    ).toBe("narrow");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("cascades exclusive → narrow → soft when no override AND no narrowing field", () => {
    expect(validateIntent("exclusive", {})).toBe("soft");
  });

  it("keeps exclusive when availability.restrictToSlots is present", () => {
    expect(
      validateIntent("exclusive", {
        availability: { restrictToSlots: [{ start: "a", end: "b" }] },
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
    expect(deriveLegacy({ availability: { restrictToDays: ["Tue"] } })).toBe("narrow");
    expect(deriveLegacy({ preferred: { days: ["Tue"] } })).toBe("narrow");
    expect(deriveLegacy({ dateRange: { start: "2026-04-21", end: "2026-04-23" } })).toBe("narrow");
  });

  it("returns exclusive when availability.restrictToSlots is present", () => {
    expect(
      deriveLegacy({
        availability: { restrictToSlots: [{ start: "a", end: "b" }] },
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

describe("hasMaterialNarrowingChange (§4.7 split rule, post-2026-05-01)", () => {
  it("is false for no-op edits", () => {
    expect(hasMaterialNarrowingChange({}, {})).toBe(false);
    expect(
      hasMaterialNarrowingChange(
        { availability: { restrictToDays: ["Tue"] } },
        { availability: { restrictToDays: ["Tue"] } },
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

  it("flags availability.restrictToWindows added where none existed", () => {
    expect(
      hasMaterialNarrowingChange({}, { availability: { restrictToWindows: [{ start: "12:00", end: "14:00" }] } }),
    ).toBe(true);
  });

  it("flags availability.restrictToDays added where none existed", () => {
    expect(hasMaterialNarrowingChange({}, { availability: { restrictToDays: ["Tue"] } })).toBe(true);
  });

  it("flags preferred.days added where none existed", () => {
    expect(hasMaterialNarrowingChange({}, { preferred: { days: ["Tue"] } })).toBe(true);
  });

  it("flags preferred.windows added where none existed", () => {
    expect(
      hasMaterialNarrowingChange({}, { preferred: { windows: [{ start: "12:00", end: "14:00" }] } }),
    ).toBe(true);
  });

  it("flags adding availability.restrictToSlots where none existed", () => {
    expect(
      hasMaterialNarrowingChange({}, { availability: { restrictToSlots: [{ start: "a", end: "b" }] } }),
    ).toBe(true);
  });

  it("does NOT flag trivial value tweaks that preserve the shape", () => {
    expect(
      hasMaterialNarrowingChange(
        { availability: { restrictToDays: ["Mon"] } },
        { availability: { restrictToDays: ["Tue"] } },
      ),
    ).toBe(false);
  });
});

describe("greeting useGenericBody decision (integration shape)", () => {
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
});
