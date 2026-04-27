/**
 * Filter-bucket classifier for the mobile Event Links sheet.
 *
 * The sheet's "Upcoming events" group filters sessions into five buckets per
 * PROJECT-PLAN line 112: All / Coordinating / Confirmed / Needs you / Past.
 * The classifier is pure (status + agreedTime + clock → bucket) so it can be
 * unit-tested without rendering React, and so the sheet and any future
 * desktop equivalent (Phase 2) share the same canonical mapping.
 *
 * Status values come from `NegotiationSession.status` — same shape returned
 * by `/api/negotiate/sessions?archived=false`. Vocabulary follows
 * `SPEC-2.0.md §2.6` (Coordination, not Negotiation; user-facing pills only).
 */
export type EventBucket = "coordinating" | "confirmed" | "needs_you" | "past";
export type EventFilter = "all" | EventBucket;

/** All filter chip ids in display order. */
export const EVENT_FILTERS: readonly EventFilter[] = [
  "all",
  "coordinating",
  "confirmed",
  "needs_you",
  "past",
] as const;

/** Filter-chip labels exactly as they render on the sheet. The classifier
 *  doesn't read these; they live here so the component imports a single
 *  source of truth. */
export const EVENT_FILTER_LABELS: Record<EventFilter, string> = {
  all: "All",
  coordinating: "Coord.",
  confirmed: "Confirmed",
  needs_you: "Needs you",
  past: "Past",
};

/** Pill labels — what renders on each event row's status pill. */
export const EVENT_PILL_LABELS: Record<EventBucket, string> = {
  coordinating: "Coord.",
  confirmed: "Confirmed",
  needs_you: "Needs you",
  past: "Past",
};

export interface SessionLike {
  /** NegotiationSession.status — "active" | "agreed" | "expired" | "cancelled" | "escalated" | etc. */
  status: string;
  /** ISO datetime of the agreed slot, when the session has reached agreed. */
  agreedTime?: string | null;
  /** Optional pre-shaped statusLabel — when present and the status is
   *  "escalated"/"awaiting_ack_self", the session falls into "needs_you". */
  statusLabel?: string | null;
}

/**
 * Classify a session into one of the four event buckets. Past wins over
 * Confirmed: an agreed meeting whose time has already elapsed renders as
 * Past, matching the auto-archive heuristic on the existing meetings page
 * (`app/src/app/dashboard/meetings/page.tsx:94-100`).
 *
 * `now` is parameterized so tests can pin the clock; production calls pass
 * `Date.now()`.
 */
export function classifySession(s: SessionLike, now: number = Date.now()): EventBucket {
  // Past — agreedTime has elapsed, OR the session expired/cancelled.
  if (s.status === "expired" || s.status === "cancelled") return "past";
  if (s.agreedTime) {
    const t = Date.parse(s.agreedTime);
    if (Number.isFinite(t) && t < now) return "past";
  }

  // Needs-you — anything explicitly flagged as awaiting host action. The
  // negotiate/sessions endpoint surfaces this through `statusLabel` text;
  // we also catch the canonical "escalated" status which always means
  // host attention required.
  if (s.status === "escalated") return "needs_you";
  if (s.status === "active" && typeof s.statusLabel === "string") {
    const label = s.statusLabel.toLowerCase();
    if (label.includes("needs you") || label.includes("waiting for you") || label.includes("you to confirm")) {
      return "needs_you";
    }
  }

  // Confirmed — agreed but not yet past.
  if (s.status === "agreed") return "confirmed";

  // Default — every other live session is mid-coordination.
  return "coordinating";
}

/** True when a session belongs to the chosen filter. "all" admits everything. */
export function matchesFilter(s: SessionLike, filter: EventFilter, now: number = Date.now()): boolean {
  if (filter === "all") return true;
  return classifySession(s, now) === filter;
}
