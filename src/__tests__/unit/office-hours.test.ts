import { describe, it, expect } from "vitest";
import { applyOfficeHoursWindow, generateOfficeHoursLinkCode } from "@/lib/office-hours";
import { compileOfficeHoursLinks, type AvailabilityRule } from "@/lib/availability-rules";
import type { ScoredSlot, SlotKind } from "@/lib/scoring";
import type { CompiledOfficeHoursLink } from "@/lib/availability-rules";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a ScoredSlot at a specific UTC datetime.
 * Default duration: 20 minutes (matches our canonical office-hours duration).
 */
function slotAt(
  isoStart: string,
  kind: SlotKind,
  score: number,
  durationMin: number = 20,
): ScoredSlot {
  const start = new Date(isoStart);
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    score,
    confidence: "high",
    reason: kind,
    kind,
  };
}

/**
 * Canonical office-hours rule: Tue 2–4pm Pacific, 20-min video calls.
 * daysOfWeek: [2] = Tuesday only.
 */
function oh(overrides: Partial<CompiledOfficeHoursLink> = {}): CompiledOfficeHoursLink {
  return {
    ruleId: "rule-test",
    linkCode: "abc12345",
    linkSlug: "john",
    title: "Office Hours",
    format: "video",
    durationMinutes: 20,
    windowStart: "14:00",
    windowEnd: "16:00",
    daysOfWeek: [2], // Tuesday
    ...overrides,
  };
}

// Tuesday April 21, 2026 is a Tuesday. Use it as our anchor date.
// 2026-04-21 14:00 PT = 2026-04-21 21:00 UTC (PDT, UTC-7)
const TUE_2PM_PT_UTC = "2026-04-21T21:00:00.000Z";  // Tue 2pm PT
const TUE_220_PT_UTC = "2026-04-21T21:20:00.000Z";  // Tue 2:20pm PT
const TUE_240_PT_UTC = "2026-04-21T21:40:00.000Z";  // Tue 2:40pm PT
const TUE_300_PT_UTC = "2026-04-21T22:00:00.000Z";  // Tue 3pm PT
const TUE_340_PT_UTC = "2026-04-21T22:40:00.000Z";  // Tue 3:40pm PT
const TUE_400_PT_UTC = "2026-04-21T23:00:00.000Z";  // Tue 4pm PT (outside window — end-exclusive)
const TUE_130_PT_UTC = "2026-04-21T20:30:00.000Z";  // Tue 1:30pm PT (before window)
const MON_2PM_PT_UTC = "2026-04-20T21:00:00.000Z";  // Mon 2pm PT (wrong day)

describe("applyOfficeHoursWindow — day + window filter", () => {
  it("drops slots outside the rule's daysOfWeek", () => {
    const slots = [
      slotAt(MON_2PM_PT_UTC, "open", 0),
      slotAt(TUE_2PM_PT_UTC, "open", 0),
    ];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(TUE_2PM_PT_UTC);
  });

  it("drops slots before the window start", () => {
    const slots = [slotAt(TUE_130_PT_UTC, "open", 0), slotAt(TUE_2PM_PT_UTC, "open", 0)];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(TUE_2PM_PT_UTC);
  });

  it("drops slots at/after the window end (end-exclusive)", () => {
    const slots = [slotAt(TUE_340_PT_UTC, "open", 0), slotAt(TUE_400_PT_UTC, "open", 0)];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(TUE_340_PT_UTC);
  });

  it("keeps every slot inside the window + days", () => {
    const slots = [
      slotAt(TUE_2PM_PT_UTC, "open", 0),
      slotAt(TUE_220_PT_UTC, "open", 0),
      slotAt(TUE_240_PT_UTC, "open", 0),
      slotAt(TUE_300_PT_UTC, "open", 0),
      slotAt(TUE_340_PT_UTC, "open", 0),
    ];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(5);
  });

  it("empty daysOfWeek means every day is allowed", () => {
    const slots = [slotAt(MON_2PM_PT_UTC, "open", 0), slotAt(TUE_2PM_PT_UTC, "open", 0)];
    const out = applyOfficeHoursWindow({
      rule: oh({ daysOfWeek: [] }),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(2);
  });
});

describe("applyOfficeHoursWindow — soft protection override", () => {
  it("overrides blocked_window inside the office-hours window (score → 0)", () => {
    const slots = [
      slotAt(TUE_2PM_PT_UTC, "blocked_window", 2),  // Focus Time at 2pm
    ];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
    expect(out[0].kind).toBe("open");
    expect(out[0].reason).toBe("office hours");
  });

  it("overrides off_hours (weekday outside business hours) inside the window", () => {
    const slots = [slotAt(TUE_2PM_PT_UTC, "off_hours", 1)];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out[0].score).toBe(0);
    expect(out[0].kind).toBe("open");
  });

  it("overrides weekend protection inside the window", () => {
    // A Saturday office-hours rule with a weekend-protected slot inside.
    const SAT_2PM_PT_UTC = "2026-04-25T21:00:00.000Z"; // Sat Apr 25
    const slots = [slotAt(SAT_2PM_PT_UTC, "weekend", 1)];
    const out = applyOfficeHoursWindow({
      rule: oh({ daysOfWeek: [6] }), // Sat
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
    expect(out[0].kind).toBe("open");
  });
});

describe("applyOfficeHoursWindow — hard protection preserved", () => {
  it("preserves real calendar events at their original score (never double-books)", () => {
    const slots = [
      slotAt(TUE_2PM_PT_UTC, "event", 4),         // real meeting at 2pm
      slotAt(TUE_220_PT_UTC, "open", 0),           // free at 2:20
    ];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(2);
    // The event stays at its original score/kind — downstream isOfferable() filters it.
    const eventSlot = out.find((s) => s.start === TUE_2PM_PT_UTC)!;
    expect(eventSlot.kind).toBe("event");
    expect(eventSlot.score).toBe(4);
  });

  it("preserves blackout days at their original score", () => {
    const slots = [slotAt(TUE_2PM_PT_UTC, "blackout", 4)];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out[0].kind).toBe("blackout");
    expect(out[0].score).toBe(4);
  });
});

describe("applyOfficeHoursWindow — confirmed booking subtraction", () => {
  it("drops a slot that starts exactly on a confirmed booking", () => {
    const slots = [
      slotAt(TUE_2PM_PT_UTC, "open", 0),
      slotAt(TUE_220_PT_UTC, "open", 0),
    ];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
      confirmedBookings: [
        {
          start: TUE_2PM_PT_UTC,
          end: new Date(new Date(TUE_2PM_PT_UTC).getTime() + 20 * 60 * 1000).toISOString(),
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(TUE_220_PT_UTC);
  });

  it("drops a slot that partially overlaps a confirmed booking", () => {
    // Booking 2:10–2:30pm; slot 2:20–2:40 overlaps.
    const bookingStart = "2026-04-21T21:10:00.000Z";
    const bookingEnd = "2026-04-21T21:30:00.000Z";
    const slots = [
      slotAt(TUE_2PM_PT_UTC, "open", 0),          // ends at 2:20 — does NOT overlap (end-exclusive)
      slotAt(TUE_220_PT_UTC, "open", 0),           // starts at 2:20, ends 2:40 — overlaps 2:20–2:30
      slotAt(TUE_240_PT_UTC, "open", 0),           // starts at 2:40 — no overlap
    ];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
      confirmedBookings: [{ start: bookingStart, end: bookingEnd }],
    });
    // 2pm slot overlaps 2:10–2:20 → dropped.
    // 2:20 slot overlaps 2:20–2:30 → dropped.
    // 2:40 is safe.
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(TUE_240_PT_UTC);
  });

  it("does not drop non-overlapping slots", () => {
    const slots = [
      slotAt(TUE_2PM_PT_UTC, "open", 0),
      slotAt(TUE_300_PT_UTC, "open", 0),
    ];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
      confirmedBookings: [
        {
          start: TUE_220_PT_UTC,
          end: new Date(new Date(TUE_220_PT_UTC).getTime() + 20 * 60 * 1000).toISOString(),
        },
      ],
    });
    expect(out).toHaveLength(2);
  });

  it("handles multiple confirmed bookings", () => {
    const slots = [
      slotAt(TUE_2PM_PT_UTC, "open", 0),
      slotAt(TUE_220_PT_UTC, "open", 0),
      slotAt(TUE_240_PT_UTC, "open", 0),
      slotAt(TUE_300_PT_UTC, "open", 0),
      slotAt(TUE_340_PT_UTC, "open", 0),
    ];
    const out = applyOfficeHoursWindow({
      rule: oh(),
      slots,
      timezone: "America/Los_Angeles",
      confirmedBookings: [
        {
          start: TUE_2PM_PT_UTC,
          end: new Date(new Date(TUE_2PM_PT_UTC).getTime() + 20 * 60 * 1000).toISOString(),
        },
        {
          start: TUE_300_PT_UTC,
          end: new Date(new Date(TUE_300_PT_UTC).getTime() + 20 * 60 * 1000).toISOString(),
        },
      ],
    });
    // 2pm and 3pm booked → only 2:20, 2:40, 3:40 left
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.start)).toEqual([TUE_220_PT_UTC, TUE_240_PT_UTC, TUE_340_PT_UTC]);
  });
});

describe("applyOfficeHoursWindow — expiry", () => {
  it("drops slots after the rule's expiry date", () => {
    const slots = [slotAt(TUE_2PM_PT_UTC, "open", 0)];  // Apr 21
    const out = applyOfficeHoursWindow({
      rule: oh({ expiryDate: "2026-04-20" }),  // expired before Apr 21
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(0);
  });

  it("keeps slots on or before the expiry date", () => {
    const slots = [slotAt(TUE_2PM_PT_UTC, "open", 0)];
    const out = applyOfficeHoursWindow({
      rule: oh({ expiryDate: "2026-04-21" }),
      slots,
      timezone: "America/Los_Angeles",
    });
    expect(out).toHaveLength(1);
  });
});

describe("compileOfficeHoursLinks", () => {
  function ruleOf(overrides: Partial<AvailabilityRule> = {}): AvailabilityRule {
    return {
      id: "r1",
      originalText: "office hours Tue 2-4pm",
      type: "recurring",
      action: "office_hours",
      timeStart: "14:00",
      timeEnd: "16:00",
      daysOfWeek: [2],
      status: "active",
      priority: 3,
      createdAt: "2026-04-14T00:00:00.000Z",
      officeHours: {
        title: "Office Hours",
        format: "video",
        durationMinutes: 20,
        linkSlug: "john",
        linkCode: "abc12345",
      },
      ...overrides,
    };
  }

  it("emits one entry per active office_hours rule", () => {
    const out = compileOfficeHoursLinks([
      ruleOf({ id: "r1" }),
      ruleOf({ id: "r2", officeHours: { title: "Sales Intro", format: "phone", durationMinutes: 15, linkSlug: "john", linkCode: "def99999" } }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].linkCode).toBe("abc12345");
    expect(out[1].title).toBe("Sales Intro");
    expect(out[1].format).toBe("phone");
  });

  it("skips paused rules", () => {
    const out = compileOfficeHoursLinks([ruleOf({ status: "paused" })]);
    expect(out).toHaveLength(0);
  });

  it("skips expired rules (expiryDate in the past)", () => {
    const out = compileOfficeHoursLinks([ruleOf({ expiryDate: "2020-01-01" })]);
    expect(out).toHaveLength(0);
  });

  it("skips non-office_hours rules", () => {
    const blockRule: AvailabilityRule = {
      id: "b1",
      originalText: "no meetings before 10am",
      type: "recurring",
      action: "block",
      timeStart: "00:00",
      timeEnd: "10:00",
      status: "active",
      priority: 3,
      createdAt: "2026-04-14T00:00:00.000Z",
    };
    const out = compileOfficeHoursLinks([blockRule]);
    expect(out).toHaveLength(0);
  });

  it("skips office_hours rules with no officeHours payload (malformed)", () => {
    const bad = ruleOf();
    delete bad.officeHours;
    const out = compileOfficeHoursLinks([bad]);
    expect(out).toHaveLength(0);
  });
});

describe("generateOfficeHoursLinkCode", () => {
  it("returns an 8-character lowercase alphanumeric string", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateOfficeHoursLinkCode();
      expect(code).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it("returns different codes on repeated calls (not deterministic)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add(generateOfficeHoursLinkCode());
    // With 36^8 space and 100 samples, collisions are vanishingly unlikely.
    expect(codes.size).toBe(100);
  });
});
