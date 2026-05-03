import { describe, it, expect } from "vitest";
import {
  expandRecurrence,
  toRRule,
  localWallToUTC,
  parseRecurrence,
  readRecurrence,
  isAnchorCommitted,
  commitAnchorAt,
  type LinkRecurrence,
} from "@/lib/recurrence";

const FAR_FUTURE = new Date("2030-01-01T00:00:00Z");
const FAR_PAST = new Date("2000-01-01T00:00:00Z");

describe("localWallToUTC", () => {
  it("maps 3pm PDT to 22:00 UTC", () => {
    // 2026-06-15 is in PDT (UTC-7).
    const utc = localWallToUTC("2026-06-15", "15:00", "America/Los_Angeles");
    expect(utc.toISOString()).toBe("2026-06-15T22:00:00.000Z");
  });

  it("maps 3pm PST to 23:00 UTC", () => {
    // 2026-12-15 is in PST (UTC-8).
    const utc = localWallToUTC("2026-12-15", "15:00", "America/Los_Angeles");
    expect(utc.toISOString()).toBe("2026-12-15T23:00:00.000Z");
  });

  it("preserves wall-clock across DST spring-forward (US)", () => {
    // 2026-03-07 PST (before DST), 2026-03-15 PDT (after). 3pm local both days.
    const before = localWallToUTC("2026-03-07", "15:00", "America/Los_Angeles");
    const after = localWallToUTC("2026-03-15", "15:00", "America/Los_Angeles");
    // 8-day gap but UTC difference is 7d23h (hour absorbed by DST jump).
    const gap = after.getTime() - before.getTime();
    expect(gap).toBe(8 * 24 * 3600 * 1000 - 3600 * 1000);
  });
});

describe("expandRecurrence — weekly", () => {
  const rec: LinkRecurrence = {
    v: "1",
    pattern: "weekly",
    timezone: "America/Los_Angeles",
    anchor: { firstDateLocal: "2026-05-04", timeLocal: "15:00", durationMin: 60 },
    endBy: { count: 4 },
  };

  it("emits 4 weekly occurrences", () => {
    const out = expandRecurrence(rec, FAR_PAST, FAR_FUTURE);
    expect(out).toHaveLength(4);
    expect(out[0].startAt.toISOString()).toBe("2026-05-04T22:00:00.000Z");
    expect(out[1].startAt.toISOString()).toBe("2026-05-11T22:00:00.000Z");
    expect(out[2].startAt.toISOString()).toBe("2026-05-18T22:00:00.000Z");
    expect(out[3].startAt.toISOString()).toBe("2026-05-25T22:00:00.000Z");
  });

  it("endAt respects durationMin", () => {
    const out = expandRecurrence(rec, FAR_PAST, FAR_FUTURE);
    expect(out[0].endAt.toISOString()).toBe("2026-05-04T23:00:00.000Z");
  });

  it("crosses DST: fall-back Nov 2026", () => {
    // Oct 25 is PDT; Nov 8 is PST. Both 3pm local = 22:00 / 23:00 UTC.
    const fallRec: LinkRecurrence = {
      ...rec,
      anchor: { firstDateLocal: "2026-10-25", timeLocal: "15:00", durationMin: 60 },
      endBy: { count: 3 },
    };
    const out = expandRecurrence(fallRec, FAR_PAST, FAR_FUTURE);
    expect(out[0].startAt.toISOString()).toBe("2026-10-25T22:00:00.000Z"); // PDT
    expect(out[1].startAt.toISOString()).toBe("2026-11-01T23:00:00.000Z"); // PST (DST ended Nov 1)
    expect(out[2].startAt.toISOString()).toBe("2026-11-08T23:00:00.000Z");
  });

  it("honors exclusions (RFC5545: count includes excluded)", () => {
    const exRec: LinkRecurrence = {
      ...rec,
      exclusions: ["2026-05-11T22:00:00.000Z"],
    };
    const out = expandRecurrence(exRec, FAR_PAST, FAR_FUTURE);
    // count=4; one of those 4 is excluded → 3 yielded.
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.startAt.toISOString())).toEqual([
      "2026-05-04T22:00:00.000Z",
      "2026-05-18T22:00:00.000Z",
      "2026-05-25T22:00:00.000Z",
    ]);
  });

  it("endBy.until caps the series", () => {
    const untilRec: LinkRecurrence = {
      ...rec,
      endBy: { until: "2026-05-20T00:00:00.000Z" },
    };
    const out = expandRecurrence(untilRec, FAR_PAST, FAR_FUTURE);
    expect(out).toHaveLength(3);
  });
});

describe("expandRecurrence — biweekly", () => {
  it("emits every 2 weeks", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "biweekly",
      timezone: "America/New_York",
      anchor: { firstDateLocal: "2026-05-05", timeLocal: "10:00", durationMin: 30 },
      endBy: { count: 3 },
    };
    const out = expandRecurrence(rec, FAR_PAST, FAR_FUTURE);
    expect(out).toHaveLength(3);
    expect(out[0].startAt.toISOString()).toBe("2026-05-05T14:00:00.000Z"); // EDT
    expect(out[1].startAt.toISOString()).toBe("2026-05-19T14:00:00.000Z");
    expect(out[2].startAt.toISOString()).toBe("2026-06-02T14:00:00.000Z");
  });
});

describe("expandRecurrence — monthly_nth_weekday", () => {
  it("2nd Tuesday of each month", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "monthly_nth_weekday",
      timezone: "America/Los_Angeles",
      anchor: {
        firstDateLocal: "2026-05-12", // 2nd Tue of May 2026
        timeLocal: "09:00",
        durationMin: 45,
        weekOfMonth: 2,
        dayOfWeek: 2,
      },
      endBy: { count: 4 },
    };
    const out = expandRecurrence(rec, FAR_PAST, FAR_FUTURE);
    expect(out).toHaveLength(4);
    // 2nd Tue: May 12, Jun 9, Jul 14, Aug 11
    expect(out[0].startAt.toISOString()).toBe("2026-05-12T16:00:00.000Z");
    expect(out[1].startAt.toISOString()).toBe("2026-06-09T16:00:00.000Z");
    expect(out[2].startAt.toISOString()).toBe("2026-07-14T16:00:00.000Z");
    expect(out[3].startAt.toISOString()).toBe("2026-08-11T16:00:00.000Z");
  });

  it("5th (last) Thursday handles months with only 4", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "monthly_nth_weekday",
      timezone: "UTC",
      anchor: {
        firstDateLocal: "2026-01-29", // last Thu of Jan 2026
        timeLocal: "12:00",
        durationMin: 60,
        weekOfMonth: 5,
        dayOfWeek: 4,
      },
      endBy: { count: 3 },
    };
    const out = expandRecurrence(rec, FAR_PAST, FAR_FUTURE);
    expect(out).toHaveLength(3);
    // Last Thu: Jan 29, Feb 26, Mar 26
    expect(out.map((o) => o.startAt.toISOString())).toEqual([
      "2026-01-29T12:00:00.000Z",
      "2026-02-26T12:00:00.000Z",
      "2026-03-26T12:00:00.000Z",
    ]);
  });

  it("weekOfMonth=5 means 'last' (4-Monday months emit the 4th)", () => {
    // RFC5545 -1MO semantics: "last Monday of month". Feb 2027 has only 4
    // Mondays (1, 8, 15, 22) — last is Feb 22, not a skip.
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "monthly_nth_weekday",
      timezone: "UTC",
      anchor: {
        firstDateLocal: "2027-01-25", // last Mon of Jan 2027
        timeLocal: "12:00",
        durationMin: 60,
        weekOfMonth: 5,
        dayOfWeek: 1,
      },
      endBy: { count: 3 },
    };
    const out = expandRecurrence(rec, FAR_PAST, FAR_FUTURE);
    expect(out).toHaveLength(3);
    expect(out[0].startAt.toISOString()).toBe("2027-01-25T12:00:00.000Z");
    expect(out[1].startAt.toISOString()).toBe("2027-02-22T12:00:00.000Z"); // last (4th) Mon
    expect(out[2].startAt.toISOString()).toBe("2027-03-29T12:00:00.000Z");
  });
});

describe("expandRecurrence — daily", () => {
  it("emits every day", () => {
    const rec: LinkRecurrence = {
      v: "1",
      pattern: "daily",
      timezone: "America/Los_Angeles",
      anchor: { firstDateLocal: "2026-05-04", timeLocal: "08:00", durationMin: 15 },
      endBy: { count: 5 },
    };
    const out = expandRecurrence(rec, FAR_PAST, FAR_FUTURE);
    expect(out).toHaveLength(5);
    expect(out.map((o) => o.startAt.toISOString())).toEqual([
      "2026-05-04T15:00:00.000Z",
      "2026-05-05T15:00:00.000Z",
      "2026-05-06T15:00:00.000Z",
      "2026-05-07T15:00:00.000Z",
      "2026-05-08T15:00:00.000Z",
    ]);
  });
});

describe("toRRule", () => {
  it("weekly with count", () => {
    const r = toRRule({
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: { firstDateLocal: "2026-05-04", timeLocal: "15:00", durationMin: 60 }, // Mon
      endBy: { count: 10 },
    });
    expect(r).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10");
  });

  it("biweekly sets INTERVAL=2", () => {
    const r = toRRule({
      v: "1",
      pattern: "biweekly",
      timezone: "UTC",
      anchor: { firstDateLocal: "2026-05-05", timeLocal: "10:00", durationMin: 30 }, // Tue
      endBy: { count: 5 },
    });
    expect(r).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=5");
  });

  it("monthly_nth_weekday with 'last' maps to -1", () => {
    const r = toRRule({
      v: "1",
      pattern: "monthly_nth_weekday",
      timezone: "UTC",
      anchor: {
        firstDateLocal: "2026-05-28",
        timeLocal: "12:00",
        durationMin: 60,
        weekOfMonth: 5,
        dayOfWeek: 4,
      },
      endBy: { count: 6 },
    });
    expect(r).toBe("RRULE:FREQ=MONTHLY;BYDAY=-1TH;COUNT=6");
  });

  it("until is formatted as basic-UTC", () => {
    const r = toRRule({
      v: "1",
      pattern: "weekly",
      timezone: "UTC",
      anchor: { firstDateLocal: "2026-05-04", timeLocal: "10:00", durationMin: 30 },
      endBy: { until: "2026-07-01T00:00:00.000Z" },
    });
    expect(r).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260701T000000Z");
  });
});

describe("parseRecurrence / readRecurrence", () => {
  it("accepts a valid config", () => {
    const r = parseRecurrence({
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: { firstDateLocal: "2026-05-04", timeLocal: "15:00", durationMin: 60 },
      endBy: { count: 10 },
    });
    expect(r.pattern).toBe("weekly");
  });

  it("rejects bad version", () => {
    expect(() => parseRecurrence({ v: "2" })).toThrow(/unsupported v/);
  });

  it("readRecurrence returns null on malformed JSON", () => {
    expect(readRecurrence(null)).toBeNull();
    expect(readRecurrence({ v: "1" })).toBeNull();
    expect(readRecurrence("not an object")).toBeNull();
  });

  // The "guest picks the anchor" path — composer omits firstDateLocal +
  // timeLocal at create time; the recurrence still persists so readers
  // (greeting, card, MCP) treat the link as recurring. Anchor-commit
  // promotes pre-commit → committed when the guest picks a slot.
  // Bundle: 2026-05-03 `cmop18pde0003rtbl4xe096dk` link `u36ggs`.
  it("accepts a pre-anchor-commit recurrence (firstDateLocal/timeLocal omitted)", () => {
    const r = parseRecurrence({
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: { durationMin: 45 },
      endBy: { count: 8 },
    });
    expect(r.anchor.firstDateLocal).toBeUndefined();
    expect(r.anchor.timeLocal).toBeUndefined();
    expect(r.anchor.durationMin).toBe(45);
    expect(isAnchorCommitted(r)).toBe(false);
  });

  it("rejects an anchor missing durationMin", () => {
    expect(() =>
      parseRecurrence({
        v: "1",
        pattern: "weekly",
        timezone: "America/Los_Angeles",
        anchor: {},
        endBy: { count: 8 },
      }),
    ).toThrow(/anchor\.durationMin/);
  });

  it("rejects when anchor.firstDateLocal is the wrong type", () => {
    expect(() =>
      parseRecurrence({
        v: "1",
        pattern: "weekly",
        timezone: "America/Los_Angeles",
        anchor: { durationMin: 30, firstDateLocal: 12345 },
        endBy: { count: 8 },
      }),
    ).toThrow(/anchor\.firstDateLocal/);
  });

  it("isAnchorCommitted true after firstDateLocal + timeLocal land", () => {
    const r = parseRecurrence({
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: { firstDateLocal: "2026-05-04", timeLocal: "15:00", durationMin: 45 },
      endBy: { count: 8 },
    });
    expect(isAnchorCommitted(r)).toBe(true);
  });
});

describe("commitAnchorAt", () => {
  const preCommit: LinkRecurrence = {
    v: "1",
    pattern: "weekly",
    timezone: "America/Los_Angeles",
    anchor: { durationMin: 45 },
    endBy: { count: 8 },
  };

  it("fills firstDateLocal + timeLocal from a UTC startAt in host TZ", () => {
    // 2026-05-04 22:00 UTC = 2026-05-04 15:00 PDT.
    const startAt = new Date("2026-05-04T22:00:00Z");
    const out = commitAnchorAt(preCommit, startAt, "America/Los_Angeles");
    expect(out.anchor.firstDateLocal).toBe("2026-05-04");
    expect(out.anchor.timeLocal).toBe("15:00");
    expect(out.anchor.durationMin).toBe(45);
    expect(isAnchorCommitted(out)).toBe(true);
  });

  it("late-evening UTC stays on the host's local calendar day", () => {
    // 2026-05-05 02:30 UTC = 2026-05-04 19:30 PDT (still the 4th in PDT).
    const startAt = new Date("2026-05-05T02:30:00Z");
    const out = commitAnchorAt(preCommit, startAt, "America/Los_Angeles");
    expect(out.anchor.firstDateLocal).toBe("2026-05-04");
    expect(out.anchor.timeLocal).toBe("19:30");
  });

  it("passes through an already-committed recurrence unchanged", () => {
    const committed = parseRecurrence({
      v: "1",
      pattern: "weekly",
      timezone: "America/Los_Angeles",
      anchor: { firstDateLocal: "2026-04-01", timeLocal: "09:00", durationMin: 45 },
      endBy: { count: 8 },
    });
    const out = commitAnchorAt(committed, new Date("2026-05-04T22:00:00Z"), "America/Los_Angeles");
    expect(out.anchor.firstDateLocal).toBe("2026-04-01");
    expect(out.anchor.timeLocal).toBe("09:00");
  });

  it("composes with toRRule to produce the expected RRULE", () => {
    // Anchor on a Monday, weekly count=8 → BYDAY=MO + COUNT=8.
    const startAt = new Date("2026-05-04T22:00:00Z"); // Mon 15:00 PDT
    const committed = commitAnchorAt(preCommit, startAt, "America/Los_Angeles");
    expect(toRRule(committed)).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8");
  });
});

describe("expandRecurrence / toRRule require committed anchor", () => {
  const preCommit: LinkRecurrence = {
    v: "1",
    pattern: "weekly",
    timezone: "America/Los_Angeles",
    anchor: { durationMin: 45 },
    endBy: { count: 8 },
  };

  it("expandRecurrence throws when anchor is not committed", () => {
    expect(() => expandRecurrence(preCommit, FAR_PAST, FAR_FUTURE)).toThrow(
      /anchor\.firstDateLocal and \.timeLocal/,
    );
  });

  it("toRRule throws when anchor is not committed", () => {
    expect(() => toRRule(preCommit)).toThrow(/anchor\.firstDateLocal and \.timeLocal/);
  });
});
