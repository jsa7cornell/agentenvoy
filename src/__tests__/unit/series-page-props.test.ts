/**
 * Unit tests for series-page-props.ts (PR3 of proposal
 * 2026-05-14_recurring-event-page-render-and-confirm_reviewed-2026-05-14_decided-2026-05-14.md).
 *
 * `fetchSeriesPageProps` is DB-bound and not unit-testable here.
 * Tests cover the pure `formatCadenceSentence` helper only.
 *
 * Variant axis: `{weekly, biweekly, monthly_nth_weekday, daily}` ×
 *   `{standard time (PST), daylight time (PDT)}`
 *
 * Regression cells: removing `formatCadenceSentence` or returning a wrong
 * day name must fail the "day name" assertions; timezone abbreviation errors
 * (always PST vs PDT-aware) fail the "(PDT)" assertions.
 */

import { describe, it, expect } from "vitest";
import { formatCadenceSentence } from "@/lib/series-page-props";
import type { CommittedLinkRecurrence } from "@/lib/recurrence";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Weekly — 2026-06-04 is a Thursday, America/Los_Angeles is on PDT (UTC-7)
const WEEKLY_PDT: CommittedLinkRecurrence = {
  v: "1",
  pattern: "weekly",
  timezone: "America/Los_Angeles",
  anchor: {
    durationMin: 60,
    firstDateLocal: "2026-06-04",
    timeLocal: "10:00",
  },
};

// Weekly — 2026-01-07 is a Wednesday, America/Los_Angeles is on PST (UTC-8)
const WEEKLY_PST: CommittedLinkRecurrence = {
  v: "1",
  pattern: "weekly",
  timezone: "America/Los_Angeles",
  anchor: {
    durationMin: 45,
    firstDateLocal: "2026-01-07",
    timeLocal: "09:00",
  },
};

// Biweekly — same anchor as WEEKLY_PDT
const BIWEEKLY: CommittedLinkRecurrence = {
  v: "1",
  pattern: "biweekly",
  timezone: "America/Los_Angeles",
  anchor: {
    durationMin: 60,
    firstDateLocal: "2026-06-04",
    timeLocal: "10:00",
  },
};

// Monthly nth weekday — 2026-06-04 is 1st Thursday of June
const MONTHLY: CommittedLinkRecurrence = {
  v: "1",
  pattern: "monthly_nth_weekday",
  timezone: "America/Los_Angeles",
  anchor: {
    durationMin: 30,
    firstDateLocal: "2026-06-04",
    timeLocal: "15:00",
    weekOfMonth: 1,
  },
};

// Daily
const DAILY: CommittedLinkRecurrence = {
  v: "1",
  pattern: "daily",
  timezone: "America/Los_Angeles",
  anchor: {
    durationMin: 15,
    firstDateLocal: "2026-06-04",
    timeLocal: "08:00",
  },
};

// UTC+9 (JST) — no DST — for non-US timezone coverage
const WEEKLY_JST: CommittedLinkRecurrence = {
  v: "1",
  pattern: "weekly",
  timezone: "Asia/Tokyo",
  anchor: {
    durationMin: 60,
    firstDateLocal: "2026-06-01",  // Monday
    timeLocal: "14:00",
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("formatCadenceSentence", () => {
  describe("weekly pattern — daylight time (PDT)", () => {
    const result = formatCadenceSentence(WEEKLY_PDT, "Maya");

    it("contains the host first name", () => {
      expect(result).toContain("Maya");
    });

    it("contains the correct day name (plural)", () => {
      // 2026-06-04 is a Thursday
      expect(result).toContain("Thursdays");
    });

    it("contains the correct time in 12h format", () => {
      expect(result).toContain("10:00 AM");
    });

    it("contains the PDT timezone abbreviation", () => {
      expect(result).toContain("PDT");
    });

    it("has the expected full format", () => {
      expect(result).toBe("Thursdays at 10:00 AM (PDT) · with Maya");
    });

    it("does not contain 'Every other' prefix for weekly", () => {
      expect(result).not.toContain("Every other");
    });
  });

  describe("weekly pattern — standard time (PST)", () => {
    const result = formatCadenceSentence(WEEKLY_PST, "John");

    it("contains the correct day name for 2026-01-07 (Wednesday)", () => {
      expect(result).toContain("Wednesdays");
    });

    it("contains PST (not PDT) for January", () => {
      expect(result).toContain("PST");
      expect(result).not.toContain("PDT");
    });

    it("formats 09:00 as 9:00 AM", () => {
      expect(result).toContain("9:00 AM");
    });
  });

  describe("biweekly pattern", () => {
    const result = formatCadenceSentence(BIWEEKLY, "Sarah");

    it("contains 'Every other' prefix", () => {
      expect(result).toContain("Every other");
    });

    it("still contains the day name", () => {
      expect(result).toContain("Thursdays");
    });

    it("contains the host name", () => {
      expect(result).toContain("Sarah");
    });
  });

  describe("monthly_nth_weekday pattern", () => {
    const result = formatCadenceSentence(MONTHLY, "Alex");

    it("contains 'Monthly on' prefix", () => {
      expect(result).toContain("Monthly on");
    });

    it("contains the day name", () => {
      expect(result).toContain("Thursdays");
    });

    it("formats 15:00 as 3:00 PM", () => {
      expect(result).toContain("3:00 PM");
    });
  });

  describe("daily pattern", () => {
    const result = formatCadenceSentence(DAILY, "Chris");

    it("starts with 'Daily at'", () => {
      expect(result).toMatch(/^Daily at/);
    });

    it("contains the host name", () => {
      expect(result).toContain("Chris");
    });

    it("does not contain a day name", () => {
      // Daily should not contain "Sundays", "Mondays", etc.
      expect(result).not.toMatch(/\b(Sundays|Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays)\b/);
    });
  });

  describe("non-US timezone (Asia/Tokyo — JST, no DST)", () => {
    const result = formatCadenceSentence(WEEKLY_JST, "Yuki");

    it("contains 'Mondays' for 2026-06-01", () => {
      expect(result).toContain("Mondays");
    });

    it("contains a timezone indicator (JST or GMT+9 depending on ICU data)", () => {
      // Node's ICU data may return "GMT+9" rather than "JST" — accept either
      expect(result).toMatch(/JST|GMT\+9/);
    });

    it("contains host name", () => {
      expect(result).toContain("Yuki");
    });
  });
});
