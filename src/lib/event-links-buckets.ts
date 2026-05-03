/**
 * Filter-bucket classifier for the My Events table (desktop + mobile sheet).
 *
 * Two related concepts:
 *
 *  - **Bucket** — the per-row visual state (`coordinating` | `confirmed` |
 *    `complete` | `cancelled`). Drives the status pill on each row. Pure
 *    function of `status` + `agreedTime` + clock.
 *  - **Filter** — the chip the user picks at the top of the table. The
 *    My Events redesign (2026-05-03) collapses the chip set to three:
 *    `confirmed` (default home view), `actively_coordinating` (live work
 *    that isn't archived), and `all` (everything, including past +
 *    cancelled + archived).
 *
 * Archive is a separate axis from bucket. A session can be `archived`
 * regardless of bucket — confirmed-and-archived, coordinating-and-archived,
 * etc. The non-`all` filters always exclude archived sessions; `all`
 * admits them.
 *
 * Status values come from `NegotiationSession.status` — same shape returned
 * by `/api/negotiate/sessions`. Vocabulary follows `SPEC.md §2.6`
 * (Coordination, not Negotiation; user-facing pills only).
 */
export type EventBucket = "coordinating" | "confirmed" | "complete" | "cancelled";
export type EventFilter = "confirmed" | "actively_coordinating" | "all";

/** Filter chip ids in display order. `confirmed` is the home view. */
export const EVENT_FILTERS: readonly EventFilter[] = [
  "confirmed",
  "actively_coordinating",
  "all",
] as const;

/** Default chip when the page first loads. */
export const DEFAULT_EVENT_FILTER: EventFilter = "confirmed";

/** Filter-chip labels exactly as they render on the page. */
export const EVENT_FILTER_LABELS: Record<EventFilter, string> = {
  confirmed: "Confirmed",
  actively_coordinating: "Actively Coordinating",
  all: "All Events",
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
  /** Visibility toggle on the session — orthogonal to bucket. Sessions with
   *  archived=true are hidden from confirmed/actively_coordinating chips
   *  and only appear under "All Events". */
  archived?: boolean | null;
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
  if (s.status === "expired" || s.status === "cancelled") return "cancelled";

  if (s.agreedTime) {
    const t = Date.parse(s.agreedTime);
    if (Number.isFinite(t) && t < now) return "complete";
  }

  if (s.status === "agreed") return "confirmed";

  return "coordinating";
}

/**
 * True when a session belongs to the chosen filter.
 *
 *  - `all` — admits everything, archived included.
 *  - `confirmed` — bucket === "confirmed" and not archived.
 *  - `actively_coordinating` — bucket === "coordinating" and not archived.
 */
export function matchesFilter(s: SessionLike, filter: EventFilter, now: number = Date.now()): boolean {
  if (filter === "all") return true;
  if (s.archived) return false;
  const bucket = classifySession(s, now);
  if (filter === "confirmed") return bucket === "confirmed";
  if (filter === "actively_coordinating") return bucket === "coordinating";
  return false;
}
