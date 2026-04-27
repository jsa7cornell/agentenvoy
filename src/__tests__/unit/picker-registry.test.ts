/**
 * Unit tests for the picker registry — `src/components/picker/registry.ts`.
 *
 * Two layers of coverage:
 *
 *   1. **Resolver coverage (`selectPickerVariant`)** — for each input shape
 *      the dispatcher in `availability-calendar.tsx:1149-1154` handled at
 *      HEAD before this PR, assert that the resolver returns the matching
 *      variant key. Locks the priority order (date > week > month) so
 *      future variants don't silently re-route an existing fixture.
 *
 *   2. **Component identity (`Component`)** — load-bearing for the byte-
 *      equivalence claim. The `Component` reference for each registry
 *      entry must be the SAME exported function from
 *      `availability-calendar.tsx`. If it isn't, the registry has
 *      accidentally introduced a wrapper, which would change the React
 *      reconciliation identity and could ripple into hook order, test
 *      shallow-render assertions, etc. `===` is the cheapest, strictest
 *      way to lock that.
 */
import { describe, it, expect } from "vitest";

import {
  selectPickerVariant,
  PICKER_VARIANTS,
} from "@/components/picker/registry";
import {
  WeekView,
  MonthView,
  DatePickerView,
} from "@/components/availability-calendar";

// ─── Layer 1: resolver — `selectPickerVariant` ──────────────────────────────

describe("selectPickerVariant — registry key resolution", () => {
  it("routes schedulingMode='date' to the 'date' variant", () => {
    expect(selectPickerVariant({ schedulingMode: "date" }).key).toBe("date");
  });

  it("routes view='week' to the 'week' variant", () => {
    expect(selectPickerVariant({ view: "week" }).key).toBe("week");
  });

  it("routes default (no fields) to the 'month' variant", () => {
    expect(selectPickerVariant({}).key).toBe("month");
  });

  it("date wins over week when both are set (matches HEAD precedence)", () => {
    expect(
      selectPickerVariant({ schedulingMode: "date", view: "week" }).key,
    ).toBe("date");
  });

  it("schedulingMode='time' + view='month' resolves to 'month'", () => {
    expect(
      selectPickerVariant({ schedulingMode: "time", view: "month" }).key,
    ).toBe("month");
  });

  it("schedulingMode='time' + view='week' resolves to 'week'", () => {
    expect(
      selectPickerVariant({ schedulingMode: "time", view: "week" }).key,
    ).toBe("week");
  });
});

// ─── Layer 2: registry shape ────────────────────────────────────────────────

describe("PICKER_VARIANTS — registry shape", () => {
  it("exposes 'month', 'week', and 'date' entries", () => {
    expect(PICKER_VARIANTS.month).toBeDefined();
    expect(PICKER_VARIANTS.week).toBeDefined();
    expect(PICKER_VARIANTS.date).toBeDefined();
  });

  it("each entry carries key, description, and Component", () => {
    for (const variant of Object.values(PICKER_VARIANTS)) {
      expect(typeof variant.key).toBe("string");
      expect(typeof variant.description).toBe("string");
      expect(variant.description.length).toBeGreaterThan(0);
      expect(typeof variant.Component).toBe("function");
    }
  });

  it("each entry's key matches its position in the registry map", () => {
    for (const k of Object.keys(PICKER_VARIANTS) as Array<
      keyof typeof PICKER_VARIANTS
    >) {
      expect(PICKER_VARIANTS[k].key).toBe(k);
    }
  });
});

// ─── Layer 3: component identity (byte-equivalence anchor) ──────────────────

describe("PICKER_VARIANTS — component identity (byte-equivalence)", () => {
  it("'week' Component is the WeekView export from availability-calendar", () => {
    expect(PICKER_VARIANTS.week.Component).toBe(WeekView);
  });

  it("'month' Component is the MonthView export from availability-calendar", () => {
    expect(PICKER_VARIANTS.month.Component).toBe(MonthView);
  });

  it("'date' Component is the DatePickerView export from availability-calendar", () => {
    expect(PICKER_VARIANTS.date.Component).toBe(DatePickerView);
  });

  it("resolver returns the same component identity as the registry map", () => {
    expect(selectPickerVariant({ view: "week" }).Component).toBe(
      PICKER_VARIANTS.week.Component,
    );
    expect(selectPickerVariant({}).Component).toBe(
      PICKER_VARIANTS.month.Component,
    );
    expect(selectPickerVariant({ schedulingMode: "date" }).Component).toBe(
      PICKER_VARIANTS.date.Component,
    );
  });
});
