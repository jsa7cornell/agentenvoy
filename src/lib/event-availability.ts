/**
 * Event-availability layer — per-link decisions on top of host-stable slot
 * scores. Pure functions; never mutate `slot.score`.
 *
 * Per proposal `2026-05-01_event-availability-vs-preferred-vs-calendar-
 * scoring`. Three-band model:
 *   - Calendar availability (per-host) — scoreSlot + hoursProtectionLayer
 *   - Event availability (per-link) — THIS FILE (computeEventAvailability)
 *   - Preferred (per-link) — THIS FILE (decorateWithPreferred)
 *
 * The `slot.score` field is host-stable. Per-link decisions are carried
 * alongside as decoration: `expanded`, `preferred`. Wire-emit derivation
 * (the integer score / boolean preferred / tier emitted to MCP and the
 * picker) lives in `scoring-emit.ts`.
 */

import type { ScoredSlot, LinkParameters } from "./scoring";
import type { AvailabilitySpec } from "./link-parameters";
import { getLocalParts } from "./scoring";

const SHORT_DAY_SET = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

function localHHMM(date: Date, tz: string): string {
  const { hour, minute } = getLocalParts(date, tz);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function localDayName(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(date);
}

function timeInWindow(hhmm: string, w: { start: string; end: string }): boolean {
  return hhmm >= w.start && hhmm < w.end;
}

function slotMatchesInstance(
  slot: ScoredSlot,
  instance: { start: string; end: string },
): boolean {
  return new Date(slot.start).getTime() === new Date(instance.start).getTime();
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AvailabilitySetEntry = {
  slot: ScoredSlot;
  /** True iff slot matches any `availability.expand` entry. */
  expanded: boolean;
};

export type DecoratedAvailabilitySetEntry = AvailabilitySetEntry & {
  /** True iff slot is in `preferred.{days|windows|slots}`. Decoration only. */
  preferred: boolean;
};

// ---------------------------------------------------------------------------
// computeEventAvailability — filter only, never mutates slot.score.
// ---------------------------------------------------------------------------

/**
 * Apply event-availability decisions on top of host-stable scored slots.
 *
 * Filters by hard constraints (`dateRange`, `blockedRanges`,
 * `availability.restrictToDays`, `availability.restrictToWindows`,
 * `availability.restrictToSlots`, `availability.blockedSlots`) and annotates
 * surviving slots with `expanded: boolean` (true iff slot matches any
 * `availability.expand` entry).
 *
 * **Invariant:** every output entry's `slot.score` equals the input slot's
 * score. This is the load-bearing claim of the proposal — slot scores are
 * per-host stable, never per-link mutated.
 */
export function computeEventAvailability(
  scoredSlots: ScoredSlot[],
  rules: LinkParameters,
  tz: string,
): AvailabilitySetEntry[] {
  let slots = scoredSlots.slice();

  // ── Phase 1 — hard filters ────────────────────────────────────────────

  // dateRange (inclusive, host tz).
  if (rules.dateRange?.start || rules.dateRange?.end) {
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz,
    });
    const { start, end } = rules.dateRange;
    slots = slots.filter((s) => {
      const localDate = dateFmt.format(new Date(s.start));
      if (start && localDate < start) return false;
      if (end && localDate > end) return false;
      return true;
    });
  }

  // blockedRanges (range subtraction).
  const blockedRanges = (rules.blockedRanges ?? [])
    .map((r) => ({ startMs: Date.parse(r.start), endMs: Date.parse(r.end) }))
    .filter((r) => !Number.isNaN(r.startMs) && !Number.isNaN(r.endMs) && r.startMs < r.endMs);
  if (blockedRanges.length > 0) {
    slots = slots.filter((slot) => {
      const sStart = new Date(slot.start).getTime();
      const sEnd = new Date(slot.end).getTime();
      return !blockedRanges.some((b) => sStart < b.endMs && sEnd > b.startMs);
    });
  }

  // Transition: old rows carry AvailabilitySpec object; new rows carry AvailabilityWindow[].
  // AvailabilitySpec fields (blockedSlots, restrictToDays, etc.) are no-ops for new-model links.
  const availSpec: AvailabilitySpec | undefined = !Array.isArray(rules.availability)
    ? rules.availability
    : undefined;

  // availability.blockedSlots (named singular slot exclusions).
  const blockedSlots = availSpec?.blockedSlots;
  if (blockedSlots?.length) {
    slots = slots.filter(
      (slot) => !blockedSlots.some((b) => slotMatchesInstance(slot, b)),
    );
  }

  // availability.restrictToDays.
  const restrictToDays = availSpec?.restrictToDays;
  if (restrictToDays?.length) {
    const allowed = new Set<string>(
      (restrictToDays as readonly string[]).filter((d) => SHORT_DAY_SET.has(d)),
    );
    if (allowed.size > 0) {
      slots = slots.filter((s) => allowed.has(localDayName(new Date(s.start), tz)));
    }
  }

  // availability.restrictToWindows.
  const restrictToWindows = availSpec?.restrictToWindows;
  if (restrictToWindows?.length) {
    slots = slots.filter((s) => {
      const t = localHHMM(new Date(s.start), tz);
      return restrictToWindows.some((w) => timeInWindow(t, w));
    });
  }

  // availability.restrictToSlots — when present, ONLY these are bookable.
  const restrictToSlots = availSpec?.restrictToSlots;
  if (restrictToSlots?.length) {
    slots = slots.filter((s) =>
      restrictToSlots.some((r) => slotMatchesInstance(s, r)),
    );
  }

  // ── Phase 2 — annotate `expanded` ─────────────────────────────────────

  const expand = availSpec?.expand;
  return slots.map((slot) => ({
    slot,
    expanded: !!expand?.length && matchesAnyExpand(slot, expand, tz),
  }));
}

function matchesAnyExpand(
  slot: ScoredSlot,
  expand: NonNullable<AvailabilitySpec["expand"]>,
  tz: string,
): boolean {
  const slotDate = new Date(slot.start);
  const slotDay = localDayName(slotDate, tz);
  const slotTime = localHHMM(slotDate, tz);
  return expand.some((entry) => {
    if (entry.days?.length && !entry.days.includes(slotDay as never)) return false;
    if (entry.window && !timeInWindow(slotTime, entry.window)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// decorateWithPreferred — adds the `preferred: boolean` flag.
// ---------------------------------------------------------------------------

/**
 * Annotate availability entries with `preferred: boolean`.
 *
 * `preferred` is true iff the slot matches ANY of:
 *   - `preferred.days` (slot's local day name)
 *   - `preferred.windows` (slot's local HH:MM falls in any window)
 *   - `preferred.slots` (slot's start instant matches a pinned instance)
 *
 * Per B3 unification: pinned-as-preference lives in `preferred.slots`, so
 * the predicate has no special cases. Replaces the legacy
 * `slot.score <= -1` derivation that depended on score mutation.
 *
 * **Invariant:** every output entry's `slot.score` equals the input
 * entry's slot.score. Pure decoration.
 */
export function decorateWithPreferred(
  set: AvailabilitySetEntry[],
  rules: LinkParameters,
  tz: string,
): DecoratedAvailabilitySetEntry[] {
  const pref = rules.preferred;
  if (!pref) {
    return set.map((e) => ({ ...e, preferred: false }));
  }
  return set.map((entry) => ({
    ...entry,
    preferred: slotIsPreferred(entry.slot, pref, tz),
  }));
}

function slotIsPreferred(
  slot: ScoredSlot,
  pref: NonNullable<LinkParameters["preferred"]>,
  tz: string,
): boolean {
  const slotDate = new Date(slot.start);
  if (pref.days?.length) {
    if (pref.days.includes(localDayName(slotDate, tz) as never)) return true;
  }
  if (pref.windows?.length) {
    const t = localHHMM(slotDate, tz);
    if (pref.windows.some((w) => timeInWindow(t, w))) return true;
  }
  if (pref.slots?.length) {
    if (pref.slots.some((s) => slotMatchesInstance(slot, s))) return true;
  }
  return false;
}
