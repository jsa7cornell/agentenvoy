/**
 * Picker registry — the time/date selection surface a guest interacts with
 * inside the deal-room (and any future caller). Each entry pairs a stable
 * key with the React component that renders that variant.
 *
 * `selectPickerVariant(input)` returns the matching entry; the dispatcher
 * inside `availability-calendar.tsx` just calls this resolver and mounts
 * `entry.Component` with the (already-destructured) rest of the props.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * What belongs IN this registry
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Anything a guest interacts with as their picker surface inside the deal-
 * room — the question is "how does the guest tell us when (or whether) they
 * want to meet?" Different answers = different registry entries.
 *
 * Today's three entries map 1:1 to the in-file dispatcher this registry
 * replaces (`availability-calendar.tsx:1149-1154` at HEAD `8d31d3c`):
 *
 *   - "month" — Month-grid view (default for routes that don't pass `view`).
 *     Renders day cells with binned slots; clicking a day reveals time pills.
 *   - "week" — Week-strip view (deal-room default — `deal-room.tsx:1900`
 *     passes `view="week"`). Renders 7 day columns with slot pills inline.
 *   - "date" — Date-only picker (no times). Renders a date grid for guests
 *     when the host hasn't yet committed to a time (multi-day events,
 *     duration ≥ 24h). Selected via `schedulingMode="date"`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Adding a new picker variant
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   1. Add a new literal to `PickerVariantKey`.
 *   2. Add a new entry to `PICKER_VARIANTS` with `key`, `description`, and
 *      a `Component` that accepts `PickerVariantProps` (see below — same
 *      shape as today's `<AvailabilityCalendar>` minus the dispatch-only
 *      fields `view` / `schedulingMode`).
 *   3. Extend `selectPickerVariant`'s resolver if the new entry isn't
 *      reachable through today's two select fields. The resolver input
 *      type (`PickerVariantSelectInput`) is open for future variants to
 *      add fields — keep the resolver tolerant of unknown inputs.
 *
 * Wishlist examples (already motivating cases in PROJECT-PLAN.md):
 *
 *   - **No-picker for Track 2 multi-user coordination.** When the deal-room
 *     synthesis table replaces individual time-picking (multi-user "no-
 *     picker" mode — see PROJECT-PLAN.md line 53 + the multi-user proposal
 *     decision 2026-04-23), this lands as a registry entry, not a route
 *     edit. The resolver gains a field on `PickerVariantSelectInput` to
 *     reach it (e.g., `link.mode`, `coordinationMode`, etc.).
 *   - **Multi-user / group picker.** A picker that shows multi-attendee
 *     intersection (3-of-5 RSVP'd, etc.) lands as a registry entry the
 *     same way.
 *   - **Location-pick-then-time.** A two-step picker that asks the guest
 *     for location first, then time — registry entry.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Byte-equivalence guarantee
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This registry is structural extraction only. The v1 entries below point
 * to the same `WeekView` / `MonthView` / `DatePickerView` components that
 * shipped at HEAD before this PR — see `picker-registry.test.ts` for the
 * component-identity assertions that lock byte-equivalence.
 */

import type { ComponentType } from "react";
import {
  WeekView,
  MonthView,
  DatePickerView,
  type AvailabilityCalendarProps,
} from "../availability-calendar";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Stable identifier for a picker variant. Existing v1 set:
 *   - "month" — Month-grid view (default).
 *   - "week" — Week-strip view (deal-room default).
 *   - "date" — Date-only picker (no times).
 *
 * Future variants document themselves in the file-level comment — add the
 * literal here, the entry to `PICKER_VARIANTS`, and the resolver branch (if
 * needed) in `selectPickerVariant`.
 */
export type PickerVariantKey = "month" | "week" | "date";

/**
 * The prop shape every variant component receives. Identical to the props
 * `AvailabilityCalendar` accepts today, minus `view` and `schedulingMode`
 * (those select the variant; they are not passed through). Imported via
 * `Omit` from the existing `AvailabilityCalendarProps` so the public API
 * surface in `availability-calendar.tsx` stays the single source of truth.
 */
export type PickerVariantProps = Omit<
  AvailabilityCalendarProps,
  "view" | "schedulingMode"
>;

/**
 * What the deal-room (and any future caller) needs to know about a picker
 * variant before it renders. Selection logic lives in `selectPickerVariant`.
 */
export interface PickerVariant {
  key: PickerVariantKey;
  /** Human-readable label for documentation + future variant registry pages. */
  description: string;
  /** The component the dispatcher mounts. */
  Component: ComponentType<PickerVariantProps>;
}

/**
 * Selection input. Today the dispatcher only reads two fields; the input
 * type is open for future variants to extend (e.g., `link.mode` for multi-
 * user, partial-attendance hints, etc.). Don't over-fit to v1's two fields.
 */
export interface PickerVariantSelectInput {
  view?: "month" | "week";
  schedulingMode?: "time" | "date";
  /** Future variants will add fields here — keep the resolver tolerant. */
}

// ─── Variant entries ─────────────────────────────────────────────────────────

const monthVariant: PickerVariant = {
  key: "month",
  description:
    "Month-grid view (default). Renders day cells with binned slots; " +
    "clicking a day reveals time-slot pills. Used by callers that don't " +
    "pass `view` and operate in scheduling mode 'time'.",
  Component: MonthView as ComponentType<PickerVariantProps>,
};

const weekVariant: PickerVariant = {
  key: "week",
  description:
    "Week-strip view (deal-room default). Renders 7 day columns with " +
    "slot pills inline. Selected by `view=\"week\"`.",
  Component: WeekView as ComponentType<PickerVariantProps>,
};

const dateVariant: PickerVariant = {
  key: "date",
  description:
    "Date-only picker (no times). Renders a date grid for guests when the " +
    "host hasn't committed to a time (multi-day events, duration ≥ 24h). " +
    "Selected by `schedulingMode=\"date\"`; takes precedence over `view`.",
  Component: DatePickerView as ComponentType<PickerVariantProps>,
};

// ─── Registry + resolver ─────────────────────────────────────────────────────

/**
 * The registry, exported as a const map for both lookup-by-key and
 * iteration. Selection priority is encoded in `selectPickerVariant`, NOT
 * in this map's iteration order.
 */
export const PICKER_VARIANTS: Record<PickerVariantKey, PickerVariant> = {
  month: monthVariant,
  week: weekVariant,
  date: dateVariant,
};

/**
 * Resolve which variant renders for the current input. Mirrors the
 * dispatcher at `availability-calendar.tsx:1149-1154` byte-for-byte:
 *
 *   1. `schedulingMode === "date"` → "date" (date wins over view)
 *   2. `view === "week"` → "week"
 *   3. Otherwise → "month" (universal fallback)
 *
 * The resolver always returns a variant — "month" is the universal fallback.
 */
export function selectPickerVariant(
  input: PickerVariantSelectInput,
): PickerVariant {
  if (input.schedulingMode === "date") return dateVariant;
  if (input.view === "week") return weekVariant;
  return monthVariant;
}
