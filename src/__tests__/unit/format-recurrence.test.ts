/**
 * Pure-function tests for format-recurrence.ts.
 *
 * Locks the chat-driven narration reshape (proposal §3.6, 2026-05-03):
 *   - `endBy` is OPTIONAL; default-forever returns null from formatEndByLabel
 *     so callers drop the clause entirely.
 *   - formatRecurrenceSubtitle drops the count when endBy is absent.
 *   - Series length is no longer the headline.
 */
import { describe, it, expect } from "vitest";
import {
  formatCadenceWord,
  formatEndByLabel,
  formatRecurrenceSubtitle,
} from "@/lib/format-recurrence";
import type { LinkRecurrence } from "@/lib/recurrence";

const baseAnchor = {
  firstDateLocal: "2026-05-04",
  timeLocal: "15:00",
  durationMin: 30,
};

describe("formatCadenceWord", () => {
  it.each([
    ["weekly", "weekly"],
    ["biweekly", "every other week"],
    ["monthly_nth_weekday", "monthly"],
    ["daily", "daily"],
  ] as const)("pattern %s → %s", (pattern, expected) => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern,
      timezone: "America/Los_Angeles",
      anchor: baseAnchor,
    };
    expect(formatCadenceWord(rec)).toBe(expected);
  });
});

describe("formatEndByLabel — endBy optional", () => {
  it("returns null when endBy is absent (forever default — silent)", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: baseAnchor,
    };
    expect(formatEndByLabel(rec)).toBeNull();
  });

  it("formats endBy.count as N sessions", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: baseAnchor,
      endBy: { count: 8 },
    };
    expect(formatEndByLabel(rec)).toBe("8 sessions");
  });

  it("singularizes endBy.count of 1", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: baseAnchor,
      endBy: { count: 1 },
    };
    expect(formatEndByLabel(rec)).toBe("1 session");
  });

  it("formats endBy.until as 'sessions through MMM D'", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: baseAnchor,
      endBy: { until: "2026-08-30T22:00:00.000Z" },
    };
    // Allow timezone-related variation by asserting structure rather than
    // exact date; some envs format Aug 29 / Aug 30 around the boundary.
    const out = formatEndByLabel(rec);
    expect(out).toMatch(/^sessions through (Aug 29|Aug 30)$/);
  });

  it("falls back gracefully on a malformed until date", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: baseAnchor,
      endBy: { until: "not-a-date" },
    };
    expect(formatEndByLabel(rec)).toBe("a set number of sessions");
  });
});

describe("formatRecurrenceSubtitle — drops count when forever", () => {
  it("forever default → 'weekly · 30 min' (no end clause)", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: baseAnchor,
    };
    expect(formatRecurrenceSubtitle(rec)).toBe("weekly · 30 min");
  });

  it("bounded by count → 'weekly · 30 min · 8 sessions'", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: baseAnchor,
      endBy: { count: 8 },
    };
    expect(formatRecurrenceSubtitle(rec)).toBe("weekly · 30 min · 8 sessions");
  });

  it("biweekly forever default → 'every other week · 45 min'", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "biweekly",
      timezone: "America/Los_Angeles",
      anchor: { ...baseAnchor, durationMin: 45 },
    };
    expect(formatRecurrenceSubtitle(rec)).toBe("every other week · 45 min");
  });

  it("bounded by date → 'every other week · 45 min · sessions through ...'", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "biweekly",
      timezone: "America/Los_Angeles",
      anchor: { ...baseAnchor, durationMin: 45 },
      endBy: { until: "2026-08-30T22:00:00.000Z" },
    };
    const out = formatRecurrenceSubtitle(rec);
    expect(out).toMatch(/^every other week · 45 min · sessions through (Aug 29|Aug 30)$/);
  });
});
