/**
 * Bilateral availability intersection.
 *
 * Takes two scored schedules (host + guest) and produces a color-tagged array
 * describing how each 30-min slot lines up. The LLM never sees the individual
 * scores — only the resulting color — which preserves privacy (neither side
 * learns the *why* behind a slot's status).
 *
 * Privacy contract:
 *   - Green (`works_for_both`)  = bookable on both sides
 *   - Orange (`works_for_one`)  = bookable on one side, protected/tentative
 *                                  on the other (ambiguous which side).
 *   - Omitted                   = blocked on at least one side, or the host
 *                                  has no offerable window there at all.
 *
 * The "ambiguous which side" property is essential — never expose which party
 * is the blocker. Orange chips imply "there's friction here" without naming it.
 */

import type { ScoredSlot } from "@/lib/scoring";

// ─── Public types ────────────────────────────────────────────────────────────

export type BilateralColor = "both" | "one";

export interface BilateralSlot {
  start: string; // ISO
  end: string;   // ISO
  color: BilateralColor;
}

export interface ComputeBilateralInput {
  /** Host's offerable slots (already filtered to score ≤ 1 by caller, or raw). */
  hostSlots: ScoredSlot[];
  /** Guest's scored slots (raw from getOrComputeSchedule). May be empty. */
  guestSlots: ScoredSlot[];
  /**
   * When true, the guest's schedule was not available (no connected calendar
   * or fetch failed). In that case we return [] — no bilateral chips. Never
   * silently assume the guest is "open" when we have no signal.
   */
  guestScheduleAvailable: boolean;
  /** Current time. Slots before now are excluded. Parameterized for testability. */
  now?: Date;
}

// ─── Score buckets (mirrored from src/lib/scoring.ts) ────────────────────────

/** Bookable for the viewer — a slot this party is willing to offer. */
export function isBookable(score: number): boolean {
  return score <= 1;
}

/** Protected — might open up with a push, but not offered by default. */
export function isProtected(score: number): boolean {
  return score === 2 || score === 3;
}

/** Blocked — a hard no. Real event, blackout day, deep off-hours. */
export function isBlocked(score: number): boolean {
  return score >= 4;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute the bilateral color for each 30-min slot in the host's offerable
 * window. Deterministic, pure — ready for unit tests.
 *
 * Returns only slots with color "both" or "one". Slots where either side is
 * blocked, or where the host has no entry at all, are omitted (no empty cells
 * in the output — the chip list is just the actionable set).
 *
 * Results are sorted by start time ascending.
 */
export function computeBilateralAvailability(input: ComputeBilateralInput): BilateralSlot[] {
  const { hostSlots, guestSlots, guestScheduleAvailable } = input;
  const now = input.now ?? new Date();

  // Without guest signal, we cannot compute bilateral. Surface nothing —
  // callers render fall-back UI (e.g. host-only widget) instead.
  if (!guestScheduleAvailable) return [];

  // Index guest slots by start time for O(1) lookup.
  const guestByStart = new Map<string, ScoredSlot>();
  for (const g of guestSlots) {
    guestByStart.set(g.start, g);
  }

  const out: BilateralSlot[] = [];

  for (const host of hostSlots) {
    // Only consider slots in the host's offerable window. Out-of-window is
    // implicitly blocked for the host and produces no bilateral signal.
    if (!isBookable(host.score)) continue;

    // Skip past slots.
    if (new Date(host.start) <= now) continue;

    // Guest slot at the same timestamp — missing means the scoring engine
    // didn't emit one for this time, which we treat as unknown (not emitting
    // a chip, to avoid falsely claiming the guest is open).
    const guest = guestByStart.get(host.start);
    if (!guest) continue;

    // If either side is blocked (score ≥ 4), omit — no chip at all.
    if (isBlocked(guest.score)) continue;

    // Guest bookable + host bookable → GREEN.
    if (isBookable(guest.score)) {
      out.push({ start: host.start, end: host.end, color: "both" });
      continue;
    }

    // Guest protected (2–3) + host bookable → ORANGE.
    if (isProtected(guest.score)) {
      out.push({ start: host.start, end: host.end, color: "one" });
      continue;
    }

    // Unknown score state — be conservative and omit.
  }

  // Sort ascending by start time for stable, chronological rendering.
  out.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return out;
}

// ─── Day grouping helper ─────────────────────────────────────────────────────

export interface BilateralSlotsByDay {
  /** Day label in the given timezone (e.g. "Tue, Apr 21"). */
  day: string;
  slots: BilateralSlot[];
}

/**
 * Group bilateral slots by day in the given timezone for chip-list rendering.
 * Days with no slots are omitted. Preserves original slot order within each day.
 */
export function groupBilateralByDay(
  slots: BilateralSlot[],
  timezone: string,
): BilateralSlotsByDay[] {
  const byDay = new Map<string, BilateralSlot[]>();
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: timezone,
    });

  for (const slot of slots) {
    const day = fmt(slot.start);
    const list = byDay.get(day) ?? [];
    list.push(slot);
    byDay.set(day, list);
  }

  return Array.from(byDay.entries()).map(([day, slotsForDay]) => ({
    day,
    slots: slotsForDay,
  }));
}
