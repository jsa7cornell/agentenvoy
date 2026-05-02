/**
 * Event Links page bucket classifier — V1 redesign (2026-05-02).
 *
 * Pure function under test: `classifySession` / `matchesFilter` from
 * `src/lib/event-links-buckets.ts`. The page's "Upcoming events" group
 * filters sessions into All / Coordinating / Confirmed / Complete /
 * Cancelled. The classifier is the canonical mapping (desktop + mobile
 * sheet share it).
 *
 * **2026-05-02 V1 redesign change** — the prior `needs_you` bucket and
 * the `past` catch-all were retired. `past` was split into `complete`
 * (agreed time elapsed) vs `cancelled` (terminal status). Per
 * `previews/event-links-page-redesign.html` and SPEC §2.6.
 */
import { describe, it, expect } from "vitest";
import {
  classifySession,
  matchesFilter,
  EVENT_FILTERS,
  EVENT_FILTER_LABELS,
  EVENT_PILL_LABELS,
  type SessionLike,
} from "@/lib/event-links-buckets";

const NOW = Date.parse("2026-04-26T12:00:00Z");
const FUTURE = "2026-04-27T12:00:00Z";
const PAST = "2026-04-25T12:00:00Z";

describe("classifySession", () => {
  it("expired session → cancelled", () => {
    const s: SessionLike = { status: "expired" };
    expect(classifySession(s, NOW)).toBe("cancelled");
  });

  it("cancelled session → cancelled", () => {
    const s: SessionLike = { status: "cancelled" };
    expect(classifySession(s, NOW)).toBe("cancelled");
  });

  it("cancelled wins over a past agreedTime", () => {
    // A session that was scheduled for past time but got cancelled is
    // categorized as cancelled, not complete.
    const s: SessionLike = { status: "cancelled", agreedTime: PAST };
    expect(classifySession(s, NOW)).toBe("cancelled");
  });

  it("agreed-but-elapsed → complete", () => {
    const s: SessionLike = { status: "agreed", agreedTime: PAST };
    expect(classifySession(s, NOW)).toBe("complete");
  });

  it("agreed-and-future → confirmed", () => {
    const s: SessionLike = { status: "agreed", agreedTime: FUTURE };
    expect(classifySession(s, NOW)).toBe("confirmed");
  });

  it("active without agreedTime → coordinating", () => {
    const s: SessionLike = { status: "active" };
    expect(classifySession(s, NOW)).toBe("coordinating");
  });

  it("escalated → coordinating (no longer routed to needs_you)", () => {
    // 2026-05-02 redesign: needs_you bucket retired. Escalated sessions
    // surface in coordinating until they're agreed/cancelled.
    const s: SessionLike = { status: "escalated" };
    expect(classifySession(s, NOW)).toBe("coordinating");
  });

  it("statusLabel text no longer affects bucketing", () => {
    // Pre-redesign, "Needs you" / "Waiting for you" labels routed to
    // needs_you. Post-redesign, only the canonical status fields drive
    // bucketing.
    const s: SessionLike = { status: "active", statusLabel: "Waiting for you to respond" };
    expect(classifySession(s, NOW)).toBe("coordinating");
  });

  it("unknown status with no agreedTime → coordinating (default)", () => {
    const s: SessionLike = { status: "proposed" };
    expect(classifySession(s, NOW)).toBe("coordinating");
  });
});

describe("matchesFilter", () => {
  const confirmed: SessionLike = { status: "agreed", agreedTime: FUTURE };
  const cancelled: SessionLike = { status: "expired" };
  const complete: SessionLike = { status: "agreed", agreedTime: PAST };
  const coord: SessionLike = { status: "active" };

  it('"all" admits every bucket', () => {
    for (const s of [confirmed, cancelled, complete, coord]) {
      expect(matchesFilter(s, "all", NOW)).toBe(true);
    }
  });

  it("filters confirmed only", () => {
    expect(matchesFilter(confirmed, "confirmed", NOW)).toBe(true);
    expect(matchesFilter(cancelled, "confirmed", NOW)).toBe(false);
    expect(matchesFilter(complete, "confirmed", NOW)).toBe(false);
    expect(matchesFilter(coord, "confirmed", NOW)).toBe(false);
  });

  it("filters cancelled only", () => {
    expect(matchesFilter(cancelled, "cancelled", NOW)).toBe(true);
    expect(matchesFilter(confirmed, "cancelled", NOW)).toBe(false);
    expect(matchesFilter(complete, "cancelled", NOW)).toBe(false);
  });

  it("filters complete only", () => {
    expect(matchesFilter(complete, "complete", NOW)).toBe(true);
    expect(matchesFilter(cancelled, "complete", NOW)).toBe(false);
    expect(matchesFilter(confirmed, "complete", NOW)).toBe(false);
  });

  it("filters coordinating only", () => {
    expect(matchesFilter(coord, "coordinating", NOW)).toBe(true);
    expect(matchesFilter(confirmed, "coordinating", NOW)).toBe(false);
  });
});

describe("filter constants", () => {
  it("EVENT_FILTERS matches the V1 redesign ordering", () => {
    expect(EVENT_FILTERS).toEqual([
      "all",
      "coordinating",
      "confirmed",
      "complete",
      "cancelled",
    ]);
  });

  it("each filter has a label", () => {
    for (const f of EVENT_FILTERS) {
      expect(EVENT_FILTER_LABELS[f]).toBeTruthy();
    }
  });

  it("uses full word labels (not abbreviated)", () => {
    expect(EVENT_FILTER_LABELS.coordinating).toBe("Coordinating");
    expect(EVENT_FILTER_LABELS.confirmed).toBe("Confirmed");
    expect(EVENT_FILTER_LABELS.complete).toBe("Complete");
    expect(EVENT_FILTER_LABELS.cancelled).toBe("Cancelled");
  });

  it("each non-all bucket has a pill label", () => {
    expect(EVENT_PILL_LABELS.coordinating).toBe("Coordinating");
    expect(EVENT_PILL_LABELS.confirmed).toBe("Confirmed");
    expect(EVENT_PILL_LABELS.complete).toBe("Complete");
    expect(EVENT_PILL_LABELS.cancelled).toBe("Cancelled");
  });
});
