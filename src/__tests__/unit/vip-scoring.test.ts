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
  type SlotKind,
  type BlockCost,
  type BlockFirmness,
  type UserPreferences,
} from "@/lib/scoring";

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

  it("returns first-offer for open slots at score 0-2", () => {
    expect(getTier(slotOf(0), rules, TZ)).toBe("first-offer");
    expect(getTier(slotOf(1), rules, TZ)).toBe("first-offer");
    expect(getTier(slotOf(2, { blockCost: "preference", firmness: "weak" }), rules, TZ)).toBe("first-offer");
  });

  it("blocks score-3 stretch slots on a non-VIP link", () => {
    expect(getTier(slotOf(3, { kind: "weekend", blockCost: "preference", firmness: "strong" }), rules, TZ)).toBeNull();
    expect(getTier(slotOf(3, { kind: "off_hours", blockCost: "preference", firmness: "strong" }), rules, TZ)).toBeNull();
    expect(getTier(slotOf(3, { kind: "event", blockCost: "commitment", firmness: "weak" }), rules, TZ)).toBeNull();
  });

  it("blocks score-4 slots on a non-VIP link", () => {
    expect(getTier(slotOf(4, { kind: "off_hours", blockCost: "preference", firmness: "strong" }), rules, TZ)).toBeNull();
  });

  it("blocks score-5 slots regardless", () => {
    expect(getTier(slotOf(5, { kind: "event", blockCost: "commitment", firmness: "strong" }), rules, TZ)).toBeNull();
  });
});

describe("getTier — VIP link without explicit expansion", () => {
  const rules: LinkRules = { isVip: true };

  it("still gives first-offer for score 0-2 (same as non-VIP)", () => {
    expect(getTier(slotOf(0), rules, TZ)).toBe("first-offer");
    expect(getTier(slotOf(2, { blockCost: "preference", firmness: "weak" }), rules, TZ)).toBe("first-offer");
  });

  it("unlocks stretch1 at score 3 for weekend daytime", () => {
    const slot = slotOf(3, { kind: "weekend", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBe("stretch1");
  });

  it("unlocks stretch1 at score 3 for weekday off-hours", () => {
    const slot = slotOf(3, { kind: "off_hours", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBe("stretch1");
  });

  it("unlocks stretch1 at score 3 for tentative meetings (commitment:weak)", () => {
    const slot = slotOf(3, { kind: "event", blockCost: "commitment", firmness: "weak" });
    expect(getTier(slot, rules, TZ)).toBe("stretch1");
  });

  it("unlocks stretch2 at score 4 for off-hours (VIP-only, second-round reach)", () => {
    const slot = slotOf(4, { kind: "off_hours", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBe("stretch2");
  });

  it("blocks commitment:strong at score 4 even for VIP (tentative group meeting)", () => {
    const slot = slotOf(4, { kind: "event", blockCost: "commitment", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBeNull();
  });

  it("always blocks score-5 (immovable) for VIP", () => {
    expect(getTier(slotOf(5, { kind: "event", blockCost: "commitment", firmness: "strong" }), rules, TZ)).toBeNull();
  });
});

// ── Explicit pre-authorization promotes stretch to first-offer ────────────

describe("getTier — VIP with explicit preferredTimeStart", () => {
  // The slot is at 07:00 PT on a weekday, score 3 off_hours (2h edge).
  // With preferredTimeStart: "06:00", that slot falls inside the widened
  // window and is promoted to first-offer. Without pre-auth, it's stretch1.

  // 2099-06-15 14:00 UTC = 2099-06-15 07:00 PDT
  const rulesNoAuth: LinkRules = { isVip: true };
  const rulesWithAuth: LinkRules = { isVip: true, preferredTimeStart: "06:00" };
  const offHoursSlot = slotOf(
    3,
    { kind: "off_hours", blockCost: "preference", firmness: "strong" },
    "2099-06-15T14:00:00.000Z"
  );

  it("without pre-auth, 7 AM off-hours is stretch1", () => {
    expect(getTier(offHoursSlot, rulesNoAuth, TZ)).toBe("stretch1");
  });

  it("with preferredTimeStart: 06:00, 7 AM off-hours becomes first-offer", () => {
    expect(getTier(offHoursSlot, rulesWithAuth, TZ)).toBe("first-offer");
  });

  it("a score-4 slot inside the explicit window also promotes to first-offer", () => {
    const deepSlot = slotOf(
      4,
      { kind: "off_hours", blockCost: "preference", firmness: "strong" },
      "2099-06-15T14:00:00.000Z"
    );
    expect(getTier(deepSlot, rulesWithAuth, TZ)).toBe("first-offer");
  });
});

describe("getTier — VIP with allowWeekends", () => {
  const rules: LinkRules = { isVip: true, allowWeekends: true };

  it("weekend daytime (score 3) promotes to first-offer", () => {
    const slot = slotOf(3, { kind: "weekend", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBe("first-offer");
  });

  it("weekend edge (score 4) also promotes to first-offer under allowWeekends", () => {
    const slot = slotOf(4, { kind: "weekend", blockCost: "preference", firmness: "strong" });
    expect(getTier(slot, rules, TZ)).toBe("first-offer");
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
    const s1 = slotOf(1);
    const s3 = slotOf(3, { kind: "weekend", blockCost: "preference", firmness: "strong" });
    const s4 = slotOf(4, { kind: "off_hours", blockCost: "preference", firmness: "strong" });

    expect([isFirstOffer(s1, nonVip, TZ), isStretch1(s1, nonVip, TZ), isStretch2(s1, nonVip, TZ)])
      .toEqual([true, false, false]);
    expect([isFirstOffer(s3, vip, TZ), isStretch1(s3, vip, TZ), isStretch2(s3, vip, TZ)])
      .toEqual([false, true, false]);
    expect([isFirstOffer(s4, vip, TZ), isStretch1(s4, vip, TZ), isStretch2(s4, vip, TZ)])
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

  it("weekday 1h edge (9 AM when biz=10) is preference:weak, score 2", () => {
    const edgeSlot = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && hour === 9;
    });
    expect(edgeSlot).toBeDefined();
    expect(edgeSlot!.score).toBe(2);
    expect(edgeSlot!.blockCost).toBe("preference");
    expect(edgeSlot!.firmness).toBe("weak");
  });

  it("weekday 2-3h edge (7-8 AM when biz=10) is preference:strong, score 3", () => {
    const midEdge = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return !isWeekend && (hour === 7 || hour === 8);
    });
    expect(midEdge).toBeDefined();
    expect(midEdge!.score).toBe(3);
    expect(midEdge!.blockCost).toBe("preference");
    expect(midEdge!.firmness).toBe("strong");
  });

  it("weekday 4h edge (6 AM when biz=10) is score 4 (deep stretch / explicit only)", () => {
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

  it("weekend daytime is preference:strong, score 3 (stretch 1 band)", () => {
    const weekendDay = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return isWeekend && hour >= 10 && hour < 18;
    });
    expect(weekendDay).toBeDefined();
    expect(weekendDay!.score).toBe(3);
    expect(weekendDay!.kind).toBe("weekend");
    expect(weekendDay!.blockCost).toBe("preference");
  });

  it("weekend 1-2h edge is score 4 (stretch 2 band)", () => {
    const weekendEdge = slots.find((s) => {
      const { hour, isWeekend } = partsOf(s);
      return isWeekend && (hour === 8 || hour === 9 || hour === 18 || hour === 19);
    });
    expect(weekendEdge).toBeDefined();
    expect(weekendEdge!.score).toBe(4);
  });
});
