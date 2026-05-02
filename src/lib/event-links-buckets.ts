/**
 * Filter-bucket classifier for the Event Links page (desktop + mobile sheet).
 *
 * The page's "Upcoming events" group filters sessions into four buckets:
 * All / Coordinating / Confirmed / Complete / Cancelled. The classifier is
 * pure (status + agreedTime + clock → bucket) so it can be unit-tested
 * without rendering React, and so desktop + mobile share the same canonical
 * mapping.
 *
 * **2026-05-02 V1 redesign change** — `needs_you` was retired (no such
 * state exists in product) and `past` was split into `complete` (agreed,
 * time elapsed) vs `cancelled` (status terminated). Per V1 mockups
 * (`previews/event-links-page-redesign.html`) and SPEC §2.6.
 *
 * Status values come from `NegotiationSession.status` — same shape returned
 * by `/api/negotiate/sessions?archived=false`. Vocabulary follows
 * `SPEC.md §2.6` (Coordination, not Negotiation; user-facing pills only).
 */
export type EventBucket = "coordinating" | "confirmed" | "complete" | "cancelled";
export type EventFilter = "all" | EventBucket;

/** All filter chip ids in display order. */
export const EVENT_FILTERS: readonly EventFilter[] = [
  "all",
  "coordinating",
  "confirmed",
  "complete",
  "cancelled",
] as const;

/** Filter-chip labels exactly as they render on the page. The classifier
 *  doesn't read these; they live here so the component imports a single
 *  source of truth. */
export const EVENT_FILTER_LABELS: Record<EventFilter, string> = {
  all: "All",
  coordinating: "Coordinating",
  confirmed: "Confirmed",
  complete: "Complete",
  cancelled: "Cancelled",
};

/** Pill labels — what renders on each event row's status pill. */
export const EVENT_PILL_LABELS: Record<EventBucket, string> = {
  coordinating: "Coordinating",
  confirmed: "Confirmed",
  complete: "Complete",
  cancelled: "Cancelled",
};

export interface SessionLike {
  /** NegotiationSession.status — "active" | "agreed" | "expired" | "cancelled" | "escalated" | etc. */
  status: string;
  /** ISO datetime of the agreed slot, when the session has reached agreed. */
  agreedTime?: string | null;
  /** Optional pre-shaped statusLabel — currently unused by the classifier
   *  but kept on the type so callers can pass it through without losing it. */
  statusLabel?: string | null;
}

/**
 * Classify a session into one of the four event buckets.
 *
 * Priority:
 *  1. **Cancelled** — explicit terminal status (`expired` or `cancelled`)
 *     wins over everything; an agreedTime in the past doesn't matter once
 *     the session is killed.
 *  2. **Complete** — agreedTime has elapsed and status isn't terminal —
 *     the meeting actually happened (or its time has passed without a
 *     cancel).
 *  3. **Confirmed** — status `agreed` and the time is still in the future.
 *  4. **Coordinating** — every other live session.
 *
 * `now` is parameterized so tests can pin the clock; production passes
 * `Date.now()`.
 */
export function classifySession(s: SessionLike, now: number = Date.now()): EventBucket {
  // Cancelled — terminal status takes priority.
  if (s.status === "expired" || s.status === "cancelled") return "cancelled";

  // Complete — agreed time has elapsed (and not cancelled).
  if (s.agreedTime) {
    const t = Date.parse(s.agreedTime);
    if (Number.isFinite(t) && t < now) return "complete";
  }

  // Confirmed — agreed and still in the future.
  if (s.status === "agreed") return "confirmed";

  // Coordinating — every other live session.
  return "coordinating";
}

/** True when a session belongs to the chosen filter. "all" admits everything. */
export function matchesFilter(s: SessionLike, filter: EventFilter, now: number = Date.now()): boolean {
  if (filter === "all") return true;
  return classifySession(s, now) === filter;
}
