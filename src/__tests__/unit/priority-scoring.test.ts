import { describe, it, expect } from "vitest";
import {
  isOfferable,
  getPriorityConfig,
  normalizeLinkRules,
  computeSchedule,
  type ScoredSlot,
  type SlotKind,
  type UserPreferences,
} from "@/lib/scoring";

// ── Helpers ─────────────────────────────────────────────────────────────────
// All slots are future-tense (well past "now") to avoid accidental filtering
// in downstream consumers. These tests exercise isOfferable directly, which
// has no time-of-day dependency.

function slotOf(
  kind: SlotKind,
  score: number,
  when = "2099-06-15T14:00:00.000Z"
): ScoredSlot {
  const start = new Date(when);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    score,
    confidence: "high",
    reason: kind,
    kind,
  };
}

// ── Priority config ─────────────────────────────────────────────────────────

describe("getPriorityConfig", () => {
  it("defaults to normal when priority is missing", () => {
    expect(getPriorityConfig(undefined).allowWeekends).toBe(false);
    expect(getPriorityConfig(null).allowWeekends).toBe(false);
    expect(getPriorityConfig("normal").allowWeekends).toBe(false);
  });

  it("high allows weekends and just-outside-biz, not blocked windows", () => {
    const cfg = getPriorityConfig("high");
    expect(cfg.allowWeekends).toBe(true);
    expect(cfg.allowOffHours).toBe(true);
    expect(cfg.allowBlockedWindows).toBe(false);
    expect(cfg.maxScore).toBe(3);
  });

  it("vip allows everything soft including blocked windows", () => {
    const cfg = getPriorityConfig("vip");
    expect(cfg.allowWeekends).toBe(true);
    expect(cfg.allowOffHours).toBe(true);
    expect(cfg.allowBlockedWindows).toBe(true);
    expect(cfg.maxScore).toBe(4);
  });
});

// ── isOfferable — hard kinds are never offerable ───────────────────────────

describe("isOfferable — hard kinds", () => {
  it("rejects real calendar events for normal, high, and vip", () => {
    const ev = slotOf("event", 4);
    expect(isOfferable(ev, getPriorityConfig("normal"))).toBe(false);
    expect(isOfferable(ev, getPriorityConfig("high"))).toBe(false);
    expect(isOfferable(ev, getPriorityConfig("vip"))).toBe(false);
  });

  it("rejects a flight-scored event even at score 5 for everyone", () => {
    const flight = slotOf("event", 5);
    expect(isOfferable(flight, getPriorityConfig("vip"))).toBe(false);
  });

  it("rejects blackout days for everyone", () => {
    const blackout = slotOf("blackout", 5);
    expect(isOfferable(blackout, getPriorityConfig("vip"))).toBe(false);
  });
});

// ── isOfferable — normal tier matches today's behavior ─────────────────────

describe("isOfferable — normal tier (regression: today's offerings)", () => {
  const cfg = getPriorityConfig("normal");

  it("accepts open weekday slots at score 0 and 1", () => {
    expect(isOfferable(slotOf("open", 0), cfg)).toBe(true);
    expect(isOfferable(slotOf("open", 1), cfg)).toBe(true);
  });

  it("accepts score-2 and score-3 flexible slots (today's ceiling)", () => {
    expect(isOfferable(slotOf("open", 2), cfg)).toBe(true);
    expect(isOfferable(slotOf("open", 3), cfg)).toBe(true);
  });

  it("rejects score-4 slots", () => {
    expect(isOfferable(slotOf("open", 4), cfg)).toBe(false);
  });

  it("rejects weekend, off-hours, and blocked window slots", () => {
    expect(isOfferable(slotOf("weekend", 3), cfg)).toBe(false);
    expect(isOfferable(slotOf("off_hours", 2), cfg)).toBe(false);
    expect(isOfferable(slotOf("blocked_window", 4), cfg)).toBe(false);
  });
});

// ── isOfferable — high tier opens weekends and weekday off-hours ───────────

describe("isOfferable — high tier", () => {
  const cfg = getPriorityConfig("high");

  it("accepts weekday biz slots (same as normal)", () => {
    expect(isOfferable(slotOf("open", 0), cfg)).toBe(true);
    expect(isOfferable(slotOf("open", 3), cfg)).toBe(true);
  });

  it("accepts weekend daytime (score 3) and weekend off-hours that stay under ceiling", () => {
    expect(isOfferable(slotOf("weekend", 3), cfg)).toBe(true);
  });

  it("rejects weekend deep off-hours (score 4) because ceiling is 3", () => {
    expect(isOfferable(slotOf("weekend", 4), cfg)).toBe(false);
  });

  it("accepts weekday off-hours just outside biz (score 2) and within ceiling (score 3)", () => {
    expect(isOfferable(slotOf("off_hours", 2), cfg)).toBe(true);
    expect(isOfferable(slotOf("off_hours", 3), cfg)).toBe(true);
  });

  it("rejects weekday deep off-hours (score 4, e.g. 5am or 10pm)", () => {
    expect(isOfferable(slotOf("off_hours", 4), cfg)).toBe(false);
  });

  it("rejects blocked windows — high cannot override implicit host blocks", () => {
    expect(isOfferable(slotOf("blocked_window", 3), cfg)).toBe(false);
    expect(isOfferable(slotOf("blocked_window", 4), cfg)).toBe(false);
  });
});

// ── isOfferable — vip tier pierces everything soft ─────────────────────────

describe("isOfferable — vip tier", () => {
  const cfg = getPriorityConfig("vip");

  it("accepts weekend deep off-hours (score 4)", () => {
    expect(isOfferable(slotOf("weekend", 4), cfg)).toBe(true);
  });

  it("accepts weekday deep off-hours (score 4, e.g. 6am or 10pm)", () => {
    expect(isOfferable(slotOf("off_hours", 4), cfg)).toBe(true);
  });

  it("accepts blocked windows up to score 4 — VIP pierces implicit blocks", () => {
    expect(isOfferable(slotOf("blocked_window", 3), cfg)).toBe(true);
    expect(isOfferable(slotOf("blocked_window", 4), cfg)).toBe(true);
  });

  it("still rejects real calendar events even at score 4", () => {
    expect(isOfferable(slotOf("event", 4), cfg)).toBe(false);
  });

  it("still rejects score 5 slots (flight, sacred, all-day) regardless of kind", () => {
    expect(isOfferable(slotOf("open", 5), cfg)).toBe(false);
  });
});

// ── Host-explicit overrides win regardless ─────────────────────────────────

describe("isOfferable — host-explicit overrides", () => {
  it("negative scores (-1 preferred, -2 exclusive) always pass for all tiers", () => {
    const preferred = slotOf("open", -1);
    const exclusive = slotOf("open", -2);
    for (const tier of ["normal", "high", "vip"] as const) {
      const cfg = getPriorityConfig(tier);
      expect(isOfferable(preferred, cfg)).toBe(true);
      expect(isOfferable(exclusive, cfg)).toBe(true);
    }
  });
});

// ── Backward-compat: cached slots without `kind` treated as "open" ────────

describe("isOfferable — missing kind (cached pre-v2 slots)", () => {
  it("treats slots without kind as open and applies normal score ceiling", () => {
    const slot: ScoredSlot = {
      start: "2099-06-15T14:00:00.000Z",
      end: "2099-06-15T14:30:00.000Z",
      score: 2,
      confidence: "high",
      reason: "legacy",
      // no kind
    };
    expect(isOfferable(slot, getPriorityConfig("normal"))).toBe(true);
    const highScore: ScoredSlot = { ...slot, score: 4 };
    expect(isOfferable(highScore, getPriorityConfig("normal"))).toBe(false);
    // high tier does NOT magically unlock a legacy slot — it'd need a kind.
    // But since score 4 with kind "open" is above normal/high ceiling, it stays blocked.
    expect(isOfferable(highScore, getPriorityConfig("high"))).toBe(false);
    // VIP ceiling is 4 and kind is "open" → offerable.
    expect(isOfferable(highScore, getPriorityConfig("vip"))).toBe(true);
  });
});

// ── End-to-end: computeSchedule produces the full envelope ───────────────

describe("computeSchedule — full envelope generation", () => {
  const prefs: UserPreferences = {
    explicit: {
      timezone: "America/Los_Angeles",
      businessHoursStart: 10,
      businessHoursEnd: 18,
    },
  };

  const slots = computeSchedule([], prefs, null, null);

  // Helper: parse local hour in PT from a slot's ISO start.
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

  it("includes weekday slots at biz hours with kind 'open'", () => {
    const weekdayBiz = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour >= 10 && hour < 18;
    });
    expect(weekdayBiz).toBeDefined();
    expect(weekdayBiz!.kind).toBe("open");
    expect(weekdayBiz!.score).toBe(0);
  });

  it("includes weekend slots (was completely excluded pre-v2)", () => {
    const weekend = slots.find((s) => partsOf(s).isWeekend);
    expect(weekend).toBeDefined();
    expect(weekend!.kind).toBe("weekend");
    // Weekend daytime should be score 3, weekend early/late score 4.
    expect([3, 4]).toContain(weekend!.score);
  });

  it("includes weekday early-morning slots with kind 'off_hours'", () => {
    const earlyMorning = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour >= 6 && hour < 10;
    });
    expect(earlyMorning).toBeDefined();
    expect(earlyMorning!.kind).toBe("off_hours");
    // 6am is 4h before 10am biz start → deep off-hours → score 4.
    // 9am is just outside → score 2. Expect the range 2–4.
    expect([2, 3, 4]).toContain(earlyMorning!.score);
  });

  it("includes weekday late-evening slots with kind 'off_hours'", () => {
    const lateEvening = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour >= 18 && hour < 23;
    });
    expect(lateEvening).toBeDefined();
    expect(lateEvening!.kind).toBe("off_hours");
  });

  it("does not generate slots before 6 AM or after 11 PM", () => {
    const outOfEnvelope = slots.find((s) => {
      const { hour } = partsOf(s);
      return hour < 6 || hour >= 23;
    });
    expect(outOfEnvelope).toBeUndefined();
  });

  it("has noticeably more slots than pre-v2 (weekends + off-hours included)", () => {
    // Pre-v2: ~8 weeks × 5 weekdays × 16 slots/day (8h × 2) ≈ 640.
    // Post-v2: ~8 weeks × 7 days × up to 34 slots/day ≈ much more.
    // Exact count varies with "now", so just assert substantially above old ceiling.
    expect(slots.length).toBeGreaterThan(1000);
  });
});

// ── normalizeLinkRules preserves priority ─────────────────────────────────

describe("normalizeLinkRules — priority", () => {
  it("keeps canonical priority values", () => {
    expect(normalizeLinkRules({ priority: "normal" }).priority).toBe("normal");
    expect(normalizeLinkRules({ priority: "high" }).priority).toBe("high");
    expect(normalizeLinkRules({ priority: "vip" }).priority).toBe("vip");
  });

  it("drops garbage priority values", () => {
    expect(normalizeLinkRules({ priority: "URGENT" }).priority).toBeUndefined();
    expect(normalizeLinkRules({ priority: 1 }).priority).toBeUndefined();
    expect(normalizeLinkRules({ priority: null }).priority).toBeUndefined();
  });

  it("leaves missing priority alone (undefined == normal at read time)", () => {
    expect(normalizeLinkRules({}).priority).toBeUndefined();
    expect(normalizeLinkRules({ format: "video" }).priority).toBeUndefined();
  });
});
