import { describe, it, expect } from "vitest";
import {
  getTier,
  isFirstOffer,
  isStretch1,
  isStretch2,
  normalizeLinkRules,
  computeSchedule,
  type ScoredSlot,
  type LinkRules,
  type UserPreferences,
} from "@/lib/scoring";
import type { CalendarEvent } from "@/lib/calendar";

// ── Helpers ─────────────────────────────────────────────────────────────────

const TZ = "America/Los_Angeles";

/**
 * Build a synthetic ScoredSlot at a fixed future date. Tests here exercise
 * getTier / isFirstOffer / isStretch1 / isStretch2 directly — they're pure
 * functions of (slot, rules, tz).
 */
function slotOf(
  score: number,
  overrides: Partial<Pick<ScoredSlot, "kind" | "blockCost" | "firmness">> = {},
  when = "2099-06-15T14:00:00.000Z"
): ScoredSlot {
  const start = new Date(when);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    score,
    confidence: "high",
    reason: "test",
    kind: overrides.kind ?? "open",
    blockCost: overrides.blockCost ?? "none",
    firmness: overrides.firmness,
  };
}

// ── getTier — core gating logic ─────────────────────────────────────────────

describe("getTier — default non-VIP link", () => {
  const rules: LinkRules = {};

  it("returns first-offer for bookable-band slots (score 0-1)", () => {
    expect(getTier(slotOf(0), rules, TZ)).toBe("first-offer");
    expect(getTier(slotOf(1), rules, TZ)).toBe("first-offer");
  });

  it("blocks protected-band slots (score 2-3) on a non-VIP link", () => {
    expect(getTier(slotOf(2, { blockCost: "preference", firmness: "weak" }), rules, TZ)).toBeNull();
    expect(getTier(slotOf(3, { kind: "weekend", blockCost: "preference", firmness: "strong" }), rules, TZ)).toBeNull();
    expect(getTier(slotOf(3, { kind: "off_hours", blockCost: "preference", firmness: "strong" }), rules, TZ)).toBeNull();
    expect(getTier(slotOf(3, { kind: "event", blockCost: "commitment", firmness: "weak" }), rules, TZ)).toBeNull();
  });

  it("blocks score 4-5 (blocked band) for everyone", () => {
    expect(getTier(slotOf(4, { kind: "off_hours", blockCost: "preference", firmness: "strong" }), rules, TZ)).toBeNull();
    expect(getTier(slotOf(5, { kind: "event", blockCost: "commitment", firmness: "strong" }), rules, TZ)).toBeNull();
  });
});

describe("getTier — VIP link without explicit expansion", () => {
  const rules: LinkRules = { isVip: true };

  it("first-offer for bookable-band slots (score 0-1), same as non-VIP", () => {
    expect(getTier(slotOf(0), rules, TZ)).toBe("first-offer");
    expect(getTier(slotOf(1), rules, TZ)).toBe("first-offer");
  });

  it("unlocks stretch1 at score 2 (preferred within protected band)", () => {
    expect(getTier(slotOf(2, { blockCost: "preference", firmness: "weak" }), rules, TZ)).toBe("stretch1");
  });

  it("unlocks stretch2 at score 3 for weekend daytime", () => {
    const slot = slotOf(3, { kind: "weekend", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBe("stretch2");
  });

  it("unlocks stretch2 at score 3 for weekday off-hours", () => {
    const slot = slotOf(3, { kind: "off_hours", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBe("stretch2");
  });

  it("unlocks stretch2 at score 3 for tentative meetings (commitment:weak)", () => {
    const slot = slotOf(3, { kind: "event", blockCost: "commitment", firmness: "weak" });
    expect(getTier(slot, rules, TZ)).toBe("stretch2");
  });

  it("never offers score 4 — blocked band, not reachable by VIP stretch", () => {
    const slot = slotOf(4, { kind: "off_hours", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBeNull();
  });

  it("blocks commitment:strong within protected band even for VIP", () => {
    const slot = slotOf(3, { kind: "event", blockCost: "commitment", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBeNull();
  });

  it("always blocks score 5 (immovable)", () => {
    expect(getTier(slotOf(5, { kind: "event", blockCost: "commitment", firmness: "strong" }), rules, TZ)).toBeNull();
  });
});

// ── Explicit pre-authorization promotes protected slots to first-offer ────

describe("getTier — VIP with explicit preferredTimeStart", () => {
  // The slot is at 07:00 PT on a weekday, score 3 off_hours (2h edge).
  // With preferredTimeStart: "06:00", that slot falls inside the widened
  // window and is promoted to first-offer. Without pre-auth it's stretch2.

  // 2099-06-15 14:00 UTC = 2099-06-15 07:00 PDT
  const rulesNoAuth: LinkRules = { isVip: true };
  const rulesWithAuth: LinkRules = { isVip: true, preferredTimeStart: "06:00" };
  const offHoursSlot = slotOf(
    3,
    { kind: "off_hours", blockCost: "preference", firmness: "strong" },
    "2099-06-15T14:00:00.000Z"
  );

  it("without pre-auth, 7 AM off-hours is stretch2", () => {
    expect(getTier(offHoursSlot, rulesNoAuth, TZ)).toBe("stretch2");
  });

  it("with preferredTimeStart: 06:00, 7 AM off-hours becomes first-offer", () => {
    expect(getTier(offHoursSlot, rulesWithAuth, TZ)).toBe("first-offer");
  });

  it("score-4 slots stay blocked even inside the explicit window (blocked band is hard)", () => {
    const deepSlot = slotOf(
      4,
      { kind: "off_hours", blockCost: "preference", firmness: "strong" },
      "2099-06-15T14:00:00.000Z"
    );
    expect(getTier(deepSlot, rulesWithAuth, TZ)).toBeNull();
  });
});

describe("getTier — VIP with allowWeekends", () => {
  const rules: LinkRules = { isVip: true, allowWeekends: true };

  it("weekend daytime (score 3) promotes to first-offer", () => {
    const slot = slotOf(3, { kind: "weekend", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBe("first-offer");
  });

  it("weekend edge (score 4) stays blocked even under allowWeekends", () => {
    const slot = slotOf(4, { kind: "weekend", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBeNull();
  });
});

// ── Host explicit overrides (score < 0) always win ─────────────────────────

describe("getTier — host-explicit slot overrides", () => {
  it("always first-offer regardless of VIP", () => {
    const preferred = slotOf(-1, { kind: "open", blockCost: "none" });
    const exclusive = slotOf(-2, { kind: "open", blockCost: "none" });
    expect(getTier(preferred, {}, TZ)).toBe("first-offer");
    expect(getTier(exclusive, {}, TZ)).toBe("first-offer");
    expect(getTier(preferred, { isVip: true }, TZ)).toBe("first-offer");
  });
});

// ── Convenience wrappers ────────────────────────────────────────────────────

describe("isFirstOffer / isStretch1 / isStretch2 — classification helpers", () => {
  const vip: LinkRules = { isVip: true };
  const nonVip: LinkRules = {};

  it("exactly one classifier returns true for any tiered slot", () => {
    const s1 = slotOf(1); // bookable band → first-offer
    const s2 = slotOf(2, { kind: "off_hours", blockCost: "preference", firmness: "weak" }); // stretch1
    const s3 = slotOf(3, { kind: "weekend", blockCost: "preference", firmness: "strong" }); // stretch2

    expect([isFirstOffer(s1, nonVip, TZ), isStretch1(s1, nonVip, TZ), isStretch2(s1, nonVip, TZ)])
      .toEqual([true, false, false]);
    expect([isFirstOffer(s2, vip, TZ), isStretch1(s2, vip, TZ), isStretch2(s2, vip, TZ)])
      .toEqual([false, true, false]);
    expect([isFirstOffer(s3, vip, TZ), isStretch1(s3, vip, TZ), isStretch2(s3, vip, TZ)])
      .toEqual([false, false, true]);
  });

  it("all three return false for a slot that's not offerable at any tier", () => {
    const hard = slotOf(5, { kind: "event", blockCost: "commitment", firmness: "strong" });
    expect(isFirstOffer(hard, vip, TZ)).toBe(false);
    expect(isStretch1(hard, vip, TZ)).toBe(false);
    expect(isStretch2(hard, vip, TZ)).toBe(false);
  });
});

// ── normalizeLinkRules — isVip + allowWeekends + legacy migration ──────────

describe("normalizeLinkRules — VIP + legacy migration", () => {
  it("accepts boolean isVip: true", () => {
    expect(normalizeLinkRules({ isVip: true }).isVip).toBe(true);
  });

  it("accepts boolean isVip: false", () => {
    expect(normalizeLinkRules({ isVip: false }).isVip).toBe(false);
  });

  it("rejects string isVip: 'true' (not a boolean)", () => {
    expect(normalizeLinkRules({ isVip: "true" }).isVip).toBeUndefined();
  });

  it("migrates legacy priority 'high' to isVip: true", () => {
    const out = normalizeLinkRules({ priority: "high" });
    expect(out.isVip).toBe(true);
    expect(out.priority).toBeUndefined();
  });

  it("migrates legacy priority 'vip' to isVip: true", () => {
    const out = normalizeLinkRules({ priority: "vip" });
    expect(out.isVip).toBe(true);
    expect(out.priority).toBeUndefined();
  });

  it("drops legacy priority 'normal' without setting isVip", () => {
    const out = normalizeLinkRules({ priority: "normal" });
    expect(out.isVip).toBeUndefined();
    expect(out.priority).toBeUndefined();
  });

  it("accepts allowWeekends as a boolean", () => {
    expect(normalizeLinkRules({ allowWeekends: true }).allowWeekends).toBe(true);
    expect(normalizeLinkRules({ allowWeekends: false }).allowWeekends).toBe(false);
  });

  it("rejects non-boolean allowWeekends", () => {
    expect(normalizeLinkRules({ allowWeekends: "yes" }).allowWeekends).toBeUndefined();
  });
});

// ── End-to-end: computeSchedule produces the full intrinsic envelope ────────

describe("computeSchedule — v3 envelope + blockCost tagging", () => {
  const prefs: UserPreferences = {
    explicit: {
      timezone: "America/Los_Angeles",
      businessHoursStart: 10,
      businessHoursEnd: 18,
    },
  };
  const slots = computeSchedule([], prefs, null, null);

  function partsOf(slot: ScoredSlot): { hour: number; isWeekend: boolean } {
    const d = new Date(slot.start);
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      weekday: "short",
      timeZone: "America/Los_Angeles",
    }).formatToParts(d);
    const hour = Number(fmt.find((p) => p.type === "hour")?.value ?? 0);
    const day = fmt.find((p) => p.type === "weekday")?.value ?? "";
    return { hour, isWeekend: day === "Sat" || day === "Sun" };
  }

  it("extends envelope to 5 AM (was 6 AM pre-v3)", () => {
    const fiveAm = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour === 5;
    });
    expect(fiveAm).toBeDefined();
  });

  it("still caps at 11 PM (23:00) — no slots past then", () => {
    const tooLate = slots.find((s) => partsOf(s).hour >= 23);
    expect(tooLate).toBeUndefined();
  });

  it("within-biz weekday slot is blockCost: none, score 0", () => {
    const bizSlot = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour >= 10 && hour < 18;
    });
    expect(bizSlot).toBeDefined();
    expect(bizSlot!.score).toBe(0);
    expect(bizSlot!.blockCost).toBe("none");
  });

  it("weekday 1h edge (9 AM when biz=10) is preference:weak, score 2 (stretch1 / protected)", () => {
    const edgeSlot = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour === 9;
    });
    expect(edgeSlot).toBeDefined();
    expect(edgeSlot!.score).toBe(2);
    expect(edgeSlot!.blockCost).toBe("preference");
    expect(edgeSlot!.firmness).toBe("weak");
  });

  it("weekday 2-3h edge (7-8 AM when biz=10) is preference:strong, score 3 (stretch2 / protected)", () => {
    const midEdge = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && (hour === 7 || hour === 8);
    });
    expect(midEdge).toBeDefined();
    expect(midEdge!.score).toBe(3);
    expect(midEdge!.blockCost).toBe("preference");
    expect(midEdge!.firmness).toBe("strong");
  });

  it("weekday 4h edge (6 AM when biz=10) is score 4 (blocked band — not offered)", () => {
    const deepEdge = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour === 6;
    });
    expect(deepEdge).toBeDefined();
    expect(deepEdge!.score).toBe(4);
    expect(deepEdge!.blockCost).toBe("preference");
  });

  it("weekday 5h edge (5 AM when biz=10) is score 5 (sleep hours, never offered)", () => {
    const sleepEdge = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour === 5;
    });
    expect(sleepEdge).toBeDefined();
    expect(sleepEdge!.score).toBe(5);
  });

  it("weekend daytime is preference:strong, score 3 (stretch2 / protected)", () => {
    const weekendDay = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return isWeekend && hour >= 10 && hour < 18;
    });
    expect(weekendDay).toBeDefined();
    expect(weekendDay!.score).toBe(3);
    expect(weekendDay!.kind).toBe("weekend");
    expect(weekendDay!.blockCost).toBe("preference");
  });

  it("weekend 1-2h edge is score 4 (blocked band — not offered)", () => {
    const weekendEdge = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return isWeekend && (hour === 8 || hour === 9 || hour === 18 || hour === 19);
    });
    expect(weekendEdge).toBeDefined();
    expect(weekendEdge!.score).toBe(4);
  });
});

// ── Event protection overrides — rule hierarchy (Danny bug, 2026-04-18) ────
//
// An "Open" override on an event must subtract that event's protection only.
// Other rules (blocked_window, weekend hours-layer, other events) must still
// stack. A "Protected" or "Blocked" override can only raise the slot's score,
// never lower it.

describe("computeSchedule — event protection overrides (rule hierarchy)", () => {
  // Pick a Saturday several days in the future so we're past the "now" gate
  // and comfortably inside the generation envelope. The computeSchedule
  // internals snap to :00/:30 boundaries and filter past slots implicitly.
  function nextSaturday1pm(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7) + 7);
    d.setUTCHours(20, 0, 0, 0); // 20:00 UTC ≈ 1 PM PDT / 12 PM PST
    return d;
  }
  function nextMonday9am(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7 || 7) + 7);
    d.setUTCHours(16, 0, 0, 0); // 16:00 UTC ≈ 9 AM PDT
    return d;
  }

  function allDayEvent(id: string, dateISO: string): CalendarEvent {
    const start = new Date(dateISO + "T00:00:00.000Z");
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return {
      id,
      summary: "Offsite (all day)",
      start,
      end,
      calendar: "Primary",
      provider: "google",
      isAllDay: true,
      isRecurring: false,
      responseStatus: "accepted",
    };
  }

  function timedEvent(id: string, start: Date, durationMin: number): CalendarEvent {
    return {
      id,
      summary: "Untitled meeting",
      start,
      end: new Date(start.getTime() + durationMin * 60 * 1000),
      calendar: "Primary",
      provider: "google",
      isAllDay: false,
      isRecurring: false,
      responseStatus: "accepted",
    };
  }

  // Transparent event — scoreSlot returns score 1 ("FYI"). Useful for
  // exercising 3/5-override raise semantics without the event itself
  // already driving the score to 5.
  function transparentEvent(id: string, start: Date, durationMin: number): CalendarEvent {
    return {
      id,
      summary: "FYI reminder",
      start,
      end: new Date(start.getTime() + durationMin * 60 * 1000),
      calendar: "Primary",
      provider: "google",
      isAllDay: false,
      isRecurring: false,
      isTransparent: true,
      responseStatus: "accepted",
    };
  }

  it("Open override on an all-day event does NOT wipe a blocked_window rule covering the same day", () => {
    // Mon 9 AM, blocked window 00:00-10:00 strong preference (surfing).
    // All-day event with override 0 covering that Monday.
    const monday = nextMonday9am();
    const dateStr = monday.toISOString().substring(0, 10);
    const prefs: UserPreferences = {
      explicit: {
        timezone: "America/Los_Angeles",
        businessHoursStart: 10,
        businessHoursEnd: 18,
        blockedWindows: [
          { start: "00:00", end: "10:00", label: "surfing", blockCost: "preference", firmness: "strong" },
        ],
        eventProtectionOverrides: [{ eventId: "ev-allday", score: 0 }],
      },
    };
    const slots = computeSchedule([allDayEvent("ev-allday", dateStr)], prefs, null, null);
    const nineAm = slots.find((s) => Math.abs(new Date(s.start).getTime() - monday.getTime()) < 60_000);
    expect(nineAm).toBeDefined();
    // Blocked window should still apply (score 4 for preference:strong)
    expect(nineAm!.score).toBe(4);
    expect(nineAm!.kind).toBe("blocked_window");
  });

  it("Open override on an all-day event does NOT wipe weekend hours-layer protection", () => {
    const saturday = nextSaturday1pm();
    const dateStr = saturday.toISOString().substring(0, 10);
    const prefs: UserPreferences = {
      explicit: {
        timezone: "America/Los_Angeles",
        businessHoursStart: 10,
        businessHoursEnd: 18,
        eventProtectionOverrides: [{ eventId: "ev-sat", score: 0 }],
      },
    };
    const slots = computeSchedule([allDayEvent("ev-sat", dateStr)], prefs, null, null);
    const sat1pm = slots.find((s) => Math.abs(new Date(s.start).getTime() - saturday.getTime()) < 60_000);
    expect(sat1pm).toBeDefined();
    // Weekend daytime → score 3 from hours-layer (NOT 0)
    expect(sat1pm!.score).toBe(3);
    expect(sat1pm!.kind).toBe("weekend");
  });

  it("Open override on a timed event during biz hours DOES open the slot", () => {
    const monday = nextMonday9am();
    // Move to 11 AM PDT (18:00 UTC) — inside biz, no blocked window
    const elevenAm = new Date(monday.getTime() + 2 * 60 * 60 * 1000);
    const prefs: UserPreferences = {
      explicit: {
        timezone: "America/Los_Angeles",
        businessHoursStart: 10,
        businessHoursEnd: 18,
        eventProtectionOverrides: [{ eventId: "ev-timed", score: 0 }],
      },
    };
    const slots = computeSchedule([timedEvent("ev-timed", elevenAm, 30)], prefs, null, null);
    const slot = slots.find((s) => Math.abs(new Date(s.start).getTime() - elevenAm.getTime()) < 60_000);
    expect(slot).toBeDefined();
    // With the event filtered out for scoring, this slot becomes plain open
    expect(slot!.score).toBe(0);
    expect(slot!.kind).toBe("open");
  });

  it("Protected (3) override on a transparent event raises its score from 1 to 3", () => {
    const monday = nextMonday9am();
    const elevenAm = new Date(monday.getTime() + 2 * 60 * 60 * 1000);
    const prefs: UserPreferences = {
      explicit: {
        timezone: "America/Los_Angeles",
        businessHoursStart: 10,
        businessHoursEnd: 18,
        eventProtectionOverrides: [{ eventId: "ev-timed", score: 3 }],
      },
    };
    const slots = computeSchedule([transparentEvent("ev-timed", elevenAm, 30)], prefs, null, null);
    const slot = slots.find((s) => Math.abs(new Date(s.start).getTime() - elevenAm.getTime()) < 60_000);
    expect(slot).toBeDefined();
    expect(slot!.score).toBe(3);
    expect(slot!.reason).toBe("protected (host set)");
  });

  it("Protected (3) override does NOT lower a slot already scored higher by a rule", () => {
    // Blocked window scores 4 (preference:strong). A 3-override must NOT soften it.
    const monday = nextMonday9am();
    const dateStr = monday.toISOString().substring(0, 10);
    const prefs: UserPreferences = {
      explicit: {
        timezone: "America/Los_Angeles",
        businessHoursStart: 10,
        businessHoursEnd: 18,
        blockedWindows: [
          { start: "00:00", end: "10:00", label: "surfing", blockCost: "preference", firmness: "strong" },
        ],
        eventProtectionOverrides: [{ eventId: "ev-allday", score: 3 }],
      },
    };
    const slots = computeSchedule([allDayEvent("ev-allday", dateStr)], prefs, null, null);
    const nineAm = slots.find((s) => Math.abs(new Date(s.start).getTime() - monday.getTime()) < 60_000);
    expect(nineAm).toBeDefined();
    expect(nineAm!.score).toBe(4);
    expect(nineAm!.kind).toBe("blocked_window");
  });

  it("series-scoped override on master id applies to instance events that share the recurringEventId", () => {
    const monday = nextMonday9am();
    const elevenAm = new Date(monday.getTime() + 2 * 60 * 60 * 1000);
    const instance: CalendarEvent = {
      id: "inst-abc_20260420T180000Z",
      summary: "Weekly 1:1",
      start: elevenAm,
      end: new Date(elevenAm.getTime() + 30 * 60 * 1000),
      calendar: "Primary",
      provider: "google",
      isAllDay: false,
      isRecurring: true,
      recurringEventId: "master-abc",
      isTransparent: true, // force scoreSlot score=1 so override must raise
      responseStatus: "accepted",
    };
    const prefs: UserPreferences = {
      explicit: {
        timezone: "America/Los_Angeles",
        businessHoursStart: 10,
        businessHoursEnd: 18,
        // Override is keyed by the MASTER id — this is the series scope.
        eventProtectionOverrides: [{ eventId: "master-abc", score: 5, scope: "series" }],
      },
    };
    const slots = computeSchedule([instance], prefs, null, null);
    const slot = slots.find((s) => Math.abs(new Date(s.start).getTime() - elevenAm.getTime()) < 60_000);
    expect(slot).toBeDefined();
    expect(slot!.score).toBe(5);
    expect(slot!.reason).toBe("blocked (host set)");
  });

  it("instance-scoped override wins over a series-scoped override for the same event", () => {
    const monday = nextMonday9am();
    const elevenAm = new Date(monday.getTime() + 2 * 60 * 60 * 1000);
    const instance: CalendarEvent = {
      id: "inst-xyz_20260420T180000Z",
      summary: "Weekly team sync",
      start: elevenAm,
      end: new Date(elevenAm.getTime() + 30 * 60 * 1000),
      calendar: "Primary",
      provider: "google",
      isAllDay: false,
      isRecurring: true,
      recurringEventId: "master-xyz",
      isTransparent: true,
      responseStatus: "accepted",
    };
    const prefs: UserPreferences = {
      explicit: {
        timezone: "America/Los_Angeles",
        businessHoursStart: 10,
        businessHoursEnd: 18,
        eventProtectionOverrides: [
          // Series says Blocked, but this specific instance is Open.
          { eventId: "master-xyz", score: 5, scope: "series" },
          { eventId: "inst-xyz_20260420T180000Z", score: 0, scope: "instance" },
        ],
      },
    };
    const slots = computeSchedule([instance], prefs, null, null);
    const slot = slots.find((s) => Math.abs(new Date(s.start).getTime() - elevenAm.getTime()) < 60_000);
    expect(slot).toBeDefined();
    // Instance=Open filtered the event out → transparent effect gone → score 0
    expect(slot!.score).toBe(0);
    expect(slot!.kind).toBe("open");
  });

  it("Blocked (5) override raises a transparent event's score from 1 to 5", () => {
    const monday = nextMonday9am();
    const elevenAm = new Date(monday.getTime() + 2 * 60 * 60 * 1000);
    const prefs: UserPreferences = {
      explicit: {
        timezone: "America/Los_Angeles",
        businessHoursStart: 10,
        businessHoursEnd: 18,
        eventProtectionOverrides: [{ eventId: "ev-timed", score: 5 }],
      },
    };
    const slots = computeSchedule([transparentEvent("ev-timed", elevenAm, 30)], prefs, null, null);
    const slot = slots.find((s) => Math.abs(new Date(s.start).getTime() - elevenAm.getTime()) < 60_000);
    expect(slot).toBeDefined();
    expect(slot!.score).toBe(5);
    expect(slot!.reason).toBe("blocked (host set)");
  });
});
