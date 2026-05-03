/**
 * My Events table bucket + filter — 2026-05-03 redesign.
 *
 * Pure functions under test: `classifySession` / `matchesFilter` from
 * `src/lib/event-links-buckets.ts`. Buckets are unchanged
 * (coordinating | confirmed | complete | cancelled). Filters were
 * collapsed to three chips: `confirmed` (default home view),
 * `actively_coordinating` (live, not archived), `all` (everything).
 * Archive is now a filter axis: non-`all` chips exclude archived rows.
 */
import { describe, it, expect } from "vitest";
import {
  classifySession,
  matchesFilter,
  EVENT_FILTERS,
  EVENT_FILTER_LABELS,
  EVENT_PILL_LABELS,
  DEFAULT_EVENT_FILTER,
  type SessionLike,
} from "@/lib/event-links-buckets";

const NOW = Date.parse("2026-04-26T12:00:00Z");
const FUTURE = "2026-04-27T12:00:00Z";
const PAST = "2026-04-25T12:00:00Z";

describe("classifySession", () => {
  it("expired session → cancelled", () => {
    expect(classifySession({ status: "expired" }, NOW)).toBe("cancelled");
  });

  it("cancelled session → cancelled", () => {
    expect(classifySession({ status: "cancelled" }, NOW)).toBe("cancelled");
  });

  it("cancelled wins over a past agreedTime", () => {
    expect(classifySession({ status: "cancelled", agreedTime: PAST }, NOW)).toBe("cancelled");
  });

  it("agreed-but-elapsed → complete", () => {
    expect(classifySession({ status: "agreed", agreedTime: PAST }, NOW)).toBe("complete");
  });

  it("agreed-and-future → confirmed", () => {
    expect(classifySession({ status: "agreed", agreedTime: FUTURE }, NOW)).toBe("confirmed");
  });

  it("active without agreedTime → coordinating", () => {
    expect(classifySession({ status: "active" }, NOW)).toBe("coordinating");
  });

  it("escalated → coordinating", () => {
    expect(classifySession({ status: "escalated" }, NOW)).toBe("coordinating");
  });

  it("archived doesn't affect bucket", () => {
    // Bucket is purely status+time; archive is an orthogonal axis applied
    // at filter time, not at classify time.
    expect(classifySession({ status: "agreed", agreedTime: FUTURE, archived: true }, NOW)).toBe("confirmed");
  });

  it("unknown status with no agreedTime → coordinating", () => {
    expect(classifySession({ status: "proposed" }, NOW)).toBe("coordinating");
  });
});

describe("matchesFilter", () => {
  const confirmed: SessionLike = { status: "agreed", agreedTime: FUTURE };
  const cancelled: SessionLike = { status: "expired" };
  const complete: SessionLike = { status: "agreed", agreedTime: PAST };
  const coord: SessionLike = { status: "active" };
  const archivedConfirmed: SessionLike = { status: "agreed", agreedTime: FUTURE, archived: true };
  const archivedCoord: SessionLike = { status: "active", archived: true };

  it('"all" admits every bucket including archived', () => {
    for (const s of [confirmed, cancelled, complete, coord, archivedConfirmed, archivedCoord]) {
      expect(matchesFilter(s, "all", NOW)).toBe(true);
    }
  });

  it('"confirmed" admits future-agreed only, excludes archived', () => {
    expect(matchesFilter(confirmed, "confirmed", NOW)).toBe(true);
    expect(matchesFilter(archivedConfirmed, "confirmed", NOW)).toBe(false);
    expect(matchesFilter(cancelled, "confirmed", NOW)).toBe(false);
    expect(matchesFilter(complete, "confirmed", NOW)).toBe(false);
    expect(matchesFilter(coord, "confirmed", NOW)).toBe(false);
  });

  it('"actively_coordinating" admits live coordinating only, excludes archived', () => {
    expect(matchesFilter(coord, "actively_coordinating", NOW)).toBe(true);
    expect(matchesFilter(archivedCoord, "actively_coordinating", NOW)).toBe(false);
    expect(matchesFilter(confirmed, "actively_coordinating", NOW)).toBe(false);
    expect(matchesFilter(cancelled, "actively_coordinating", NOW)).toBe(false);
    expect(matchesFilter(complete, "actively_coordinating", NOW)).toBe(false);
  });
});

describe("filter constants", () => {
  it("EVENT_FILTERS reflects the 3-chip redesign in display order", () => {
    expect(EVENT_FILTERS).toEqual(["confirmed", "actively_coordinating", "all"]);
  });

  it("default filter is 'confirmed'", () => {
    expect(DEFAULT_EVENT_FILTER).toBe("confirmed");
  });

  it("each filter has a label", () => {
    for (const f of EVENT_FILTERS) {
      expect(EVENT_FILTER_LABELS[f]).toBeTruthy();
    }
  });

  it("uses the redesigned filter labels", () => {
    expect(EVENT_FILTER_LABELS.confirmed).toBe("Confirmed");
    expect(EVENT_FILTER_LABELS.actively_coordinating).toBe("Actively Coordinating");
    expect(EVENT_FILTER_LABELS.all).toBe("All Events");
  });

  it("each bucket has a pill label", () => {
    expect(EVENT_PILL_LABELS.coordinating).toBe("Coordinating");
    expect(EVENT_PILL_LABELS.confirmed).toBe("Confirmed");
    expect(EVENT_PILL_LABELS.complete).toBe("Complete");
    expect(EVENT_PILL_LABELS.cancelled).toBe("Cancelled");
  });
});
