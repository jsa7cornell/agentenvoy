/**
 * Phase 1 PR 7 — Event Links sheet bucket classifier.
 *
 * Pure function under test: `classifySession` / `matchesFilter` from
 * `src/lib/event-links-buckets.ts`. The mobile sheet's "Upcoming events"
 * group filters sessions into All / Coordinating / Confirmed / Needs you /
 * Past per `PROJECT-PLAN.md` line 112; this classifier is the canonical
 * mapping (so the future Phase 2 desktop equivalent shares it).
 *
 * Vocabulary: pill labels follow SPEC-2.0 §2.6 — "Coordination" not
 * "Negotiation", abbreviated "Coord." on the chip.
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
  it("expired session → past", () => {
    const s: SessionLike = { status: "expired" };
    expect(classifySession(s, NOW)).toBe("past");
  });

  it("cancelled session → past", () => {
    const s: SessionLike = { status: "cancelled" };
    expect(classifySession(s, NOW)).toBe("past");
  });

  it("agreed-but-elapsed → past (past beats confirmed)", () => {
    const s: SessionLike = { status: "agreed", agreedTime: PAST };
    expect(classifySession(s, NOW)).toBe("past");
  });

  it("agreed-and-future → confirmed", () => {
    const s: SessionLike = { status: "agreed", agreedTime: FUTURE };
    expect(classifySession(s, NOW)).toBe("confirmed");
  });

  it("escalated → needs_you", () => {
    const s: SessionLike = { status: "escalated" };
    expect(classifySession(s, NOW)).toBe("needs_you");
  });

  it('active + statusLabel "needs you" → needs_you', () => {
    const s: SessionLike = { status: "active", statusLabel: "Needs You: confirm slot" };
    expect(classifySession(s, NOW)).toBe("needs_you");
  });

  it('active + statusLabel "Waiting for you" → needs_you', () => {
    const s: SessionLike = { status: "active", statusLabel: "Waiting for you to respond" };
    expect(classifySession(s, NOW)).toBe("needs_you");
  });

  it("active without needs-you label → coordinating", () => {
    const s: SessionLike = {
      status: "active",
      statusLabel: "Waiting for guest",
    };
    expect(classifySession(s, NOW)).toBe("coordinating");
  });

  it("active with no label → coordinating", () => {
    const s: SessionLike = { status: "active" };
    expect(classifySession(s, NOW)).toBe("coordinating");
  });

  it("unknown status with no agreedTime → coordinating (default)", () => {
    const s: SessionLike = { status: "proposed" };
    expect(classifySession(s, NOW)).toBe("coordinating");
  });
});

describe("matchesFilter", () => {
  const confirmed: SessionLike = { status: "agreed", agreedTime: FUTURE };
  const past: SessionLike = { status: "expired" };
  const needsYou: SessionLike = { status: "escalated" };
  const coord: SessionLike = { status: "active" };

  it('"all" admits every bucket', () => {
    for (const s of [confirmed, past, needsYou, coord]) {
      expect(matchesFilter(s, "all", NOW)).toBe(true);
    }
  });

  it("filters confirmed only", () => {
    expect(matchesFilter(confirmed, "confirmed", NOW)).toBe(true);
    expect(matchesFilter(past, "confirmed", NOW)).toBe(false);
    expect(matchesFilter(needsYou, "confirmed", NOW)).toBe(false);
    expect(matchesFilter(coord, "confirmed", NOW)).toBe(false);
  });

  it("filters past only", () => {
    expect(matchesFilter(past, "past", NOW)).toBe(true);
    expect(matchesFilter(confirmed, "past", NOW)).toBe(false);
  });

  it("filters needs_you only", () => {
    expect(matchesFilter(needsYou, "needs_you", NOW)).toBe(true);
    expect(matchesFilter(coord, "needs_you", NOW)).toBe(false);
  });

  it("filters coordinating only", () => {
    expect(matchesFilter(coord, "coordinating", NOW)).toBe(true);
    expect(matchesFilter(confirmed, "coordinating", NOW)).toBe(false);
  });
});

describe("filter constants", () => {
  it("EVENT_FILTERS matches the PROJECT-PLAN ordering", () => {
    expect(EVENT_FILTERS).toEqual([
      "all",
      "coordinating",
      "confirmed",
      "needs_you",
      "past",
    ]);
  });

  it("each filter has a label", () => {
    for (const f of EVENT_FILTERS) {
      expect(EVENT_FILTER_LABELS[f]).toBeTruthy();
    }
  });

  it('uses "Coord." (per SPEC-2.0 §2.6) for the coordinating chip', () => {
    expect(EVENT_FILTER_LABELS.coordinating).toBe("Coord.");
  });

  it("each non-all bucket has a pill label", () => {
    expect(EVENT_PILL_LABELS.coordinating).toBe("Coord.");
    expect(EVENT_PILL_LABELS.confirmed).toBe("Confirmed");
    expect(EVENT_PILL_LABELS.needs_you).toBe("Needs you");
    expect(EVENT_PILL_LABELS.past).toBe("Past");
  });
});
