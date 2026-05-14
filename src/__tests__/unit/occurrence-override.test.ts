/**
 * Unit tests for occurrence-override.ts (PR2 of proposal
 * 2026-05-14_recurring-event-page-render-and-confirm).
 *
 * `applyOccurrenceOverride` is DB-bound and not unit-testable here.
 * Tests cover the pure `resolveNextUpcomingOccurrence` helper only.
 *
 * Variant axis: `{pre-commit anchor, post-commit anchor}` ×
 *   `{upcoming occurrences exist, all occurrences in the past, no recurrence}`
 *
 * Regression cells: removing `resolveNextUpcomingOccurrence` or changing it to
 * return `startAt` instead of `occurrences[0]?.startAt` must fail the
 * "returns next occurrence start" assertions.
 */

import { describe, it, expect } from "vitest";
import { resolveNextUpcomingOccurrence } from "@/lib/occurrence-override";
import type { LinkRecurrence } from "@/lib/recurrence";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Pre-commit anchor — firstDateLocal + timeLocal absent.
const PRE_COMMIT: LinkRecurrence = {
  v: "1",
  pattern: "weekly",
  timezone: "America/Los_Angeles",
  anchor: { durationMin: 45 },
};

// Post-commit anchor — weekly Wednesdays starting 2026-06-04, 10am PT.
// Chosen so "now" of 2026-05-14 has many upcoming occurrences.
const POST_COMMIT: LinkRecurrence = {
  v: "1",
  pattern: "weekly",
  timezone: "America/Los_Angeles",
  endBy: { count: 8 },
  anchor: {
    durationMin: 60,
    firstDateLocal: "2026-06-04",
    timeLocal: "10:00",
  },
};

// Post-commit anchor — all occurrences in the past relative to a 2030 "now".
const PAST_SERIES: LinkRecurrence = {
  v: "1",
  pattern: "weekly",
  timezone: "America/Los_Angeles",
  endBy: { count: 3 },
  anchor: {
    durationMin: 30,
    firstDateLocal: "2026-01-07",
    timeLocal: "09:00",
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveNextUpcomingOccurrence", () => {
  describe("pre-commit anchor (firstDateLocal + timeLocal absent)", () => {
    it("returns null — can't expand without a committed anchor", () => {
      const now = new Date("2026-05-14T00:00:00Z");
      expect(resolveNextUpcomingOccurrence(PRE_COMMIT as unknown as null, now)).toBeNull();
    });
  });

  describe("non-recurring (null input)", () => {
    it("returns null for null input", () => {
      expect(resolveNextUpcomingOccurrence(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(resolveNextUpcomingOccurrence(undefined)).toBeNull();
    });

    it("returns null for non-recurrence JSON", () => {
      expect(resolveNextUpcomingOccurrence({ foo: "bar" } as unknown as null)).toBeNull();
    });
  });

  describe("post-commit anchor with upcoming occurrences", () => {
    const now = new Date("2026-05-14T00:00:00Z"); // before first occurrence (2026-06-04)

    it("returns a Date (not null)", () => {
      expect(resolveNextUpcomingOccurrence(POST_COMMIT as unknown as null, now)).toBeInstanceOf(Date);
    });

    it("returns the first occurrence start when now is before the series begins", () => {
      const result = resolveNextUpcomingOccurrence(POST_COMMIT as unknown as null, now);
      // 2026-06-04 10:00 PT = 2026-06-04T17:00:00.000Z (PDT = UTC-7)
      expect(result?.toISOString()).toBe("2026-06-04T17:00:00.000Z");
    });

    it("returns the NEXT occurrence when now is after the first one", () => {
      // now = after the first occurrence (2026-06-04T17:00Z) but before the second (2026-06-11T17:00Z)
      const nowAfterFirst = new Date("2026-06-05T00:00:00Z");
      const result = resolveNextUpcomingOccurrence(POST_COMMIT as unknown as null, nowAfterFirst);
      expect(result?.toISOString()).toBe("2026-06-11T17:00:00.000Z");
    });

    it("result is strictly after now", () => {
      const result = resolveNextUpcomingOccurrence(POST_COMMIT as unknown as null, now);
      expect(result!.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe("post-commit anchor with all occurrences in the past", () => {
    const farFuture = new Date("2030-01-01T00:00:00Z");

    it("returns null when no upcoming occurrences exist", () => {
      expect(resolveNextUpcomingOccurrence(PAST_SERIES as unknown as null, farFuture)).toBeNull();
    });
  });
});
