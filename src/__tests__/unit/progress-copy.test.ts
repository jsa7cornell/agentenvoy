import { describe, it, expect } from "vitest";
import {
  PROGRESS_COPY,
  fillTemplate,
  selectVariant,
  templateSlots,
  type ProgressCopyInterpolation,
  type ProgressCopySlot,
} from "@/agent/progress-copy";

describe("progress-copy: templateSlots", () => {
  it("extracts slot names from a template", () => {
    expect(templateSlots("Scoring {day} against your preferences\u2026")).toEqual(["day"]);
    expect(templateSlots("Drafting the link for {guest}\u2026")).toEqual(["guest"]);
    expect(templateSlots("Scoring {day} for {guest}\u2026")).toEqual(["day", "guest"]);
  });
  it("returns empty array for slotless templates", () => {
    expect(templateSlots("Thinking it through\u2026")).toEqual([]);
  });
});

describe("progress-copy: fillTemplate", () => {
  it("fills slots when all are supplied", () => {
    expect(fillTemplate("Drafting the link for {guest}\u2026", { guest: "Josh" }))
      .toBe("Drafting the link for Josh\u2026");
  });
  it("returns null when a required slot is missing", () => {
    expect(fillTemplate("Scoring {day} against your preferences\u2026", {})).toBeNull();
    expect(fillTemplate("Scoring {day} against your preferences\u2026", { guest: "Josh" })).toBeNull();
  });
  it("passes slotless templates through unchanged", () => {
    expect(fillTemplate("Thinking it through\u2026", {})).toBe("Thinking it through\u2026");
  });
});

describe("progress-copy: selectVariant determinism", () => {
  it("returns the same variant for the same seed", () => {
    const a = selectVariant({ stage: "thinking", userId: "u1", turnIndex: 3 });
    const b = selectVariant({ stage: "thinking", userId: "u1", turnIndex: 3 });
    expect(a).toEqual(b);
  });
  it("varies across turnIndex for the same user", () => {
    const picks = new Set<string>();
    for (let t = 0; t < 20; t++) {
      const v = selectVariant({ stage: "thinking", userId: "u1", turnIndex: t });
      if (v) picks.add(v.copy);
    }
    // At least 2 distinct variants across 20 turns — rotation isn't degenerate.
    expect(picks.size).toBeGreaterThan(1);
  });
  it("prefers slotted templates when slot data is available", () => {
    // "drafting" has one slotless + one slotted-with-guest variant.
    let sawSlotted = false;
    for (let t = 0; t < 30; t++) {
      const v = selectVariant({
        stage: "drafting",
        userId: "u1",
        turnIndex: t,
        slots: { guest: "Josh" },
      });
      if (v?.slotted) sawSlotted = true;
    }
    expect(sawSlotted).toBe(true);
  });
  it("falls back to slotless when slots are missing", () => {
    const v = selectVariant({ stage: "drafting", userId: "u1", turnIndex: 1 });
    expect(v).not.toBeNull();
    expect(v!.slotted).toBe(false);
  });
});

describe("progress-copy: executing sub-variants", () => {
  it("selects per-action copy with guest slot", () => {
    const v = selectVariant({
      stage: "executing",
      action: "create_link",
      userId: "u1",
      turnIndex: 0,
      slots: { guest: "Cindy" },
    });
    expect(v).not.toBeNull();
    expect(v!.copy).toMatch(/Cindy/);
  });
  it("falls back to generic executing copy for unknown actions", () => {
    const v = selectVariant({
      stage: "executing",
      userId: "u1",
      turnIndex: 0,
    });
    expect(v).not.toBeNull();
    expect(v!.copy).toMatch(/\w/);
  });
});

describe("progress-copy: within-stage rotation", () => {
  it("rotates variants within the same stage via withinStageIndex", () => {
    const a = selectVariant({ stage: "scanning-calendar", userId: "u1", turnIndex: 0, withinStageIndex: 0 });
    const b = selectVariant({
      stage: "scanning-calendar",
      userId: "u1",
      turnIndex: 0,
      withinStageIndex: 1,
      usedIndices: new Set([a!.index]),
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.index).not.toBe(b!.index);
  });
});

describe("progress-copy: closed-union PII contract", () => {
  it("registry references only closed-union slot names", () => {
    // Walk all templates in the registry and ensure every {slot} reference
    // is one of the closed-union names. This is the runtime twin of the
    // compile-time guarantee (adding a {preference} slot is a type error).
    const allowed: ReadonlySet<string> = new Set<ProgressCopySlot>(["day", "guest", "count", "tz"]);
    const openSlotRe = /\{([a-zA-Z_]+)\}/g;
    const walk = (templates: readonly string[]) => {
      for (const t of templates) {
        let m: RegExpExecArray | null;
        while ((m = openSlotRe.exec(t)) !== null) {
          expect(allowed.has(m[1])).toBe(true);
        }
      }
    };
    for (const key of Object.keys(PROGRESS_COPY) as Array<keyof typeof PROGRESS_COPY>) {
      const value = PROGRESS_COPY[key];
      if (Array.isArray(value)) {
        walk(value as readonly string[]);
      } else {
        for (const actionKey of Object.keys(value)) {
          walk((value as Record<string, readonly string[]>)[actionKey]);
        }
      }
    }
  });
  it("compile-time: ProgressCopyInterpolation cannot hold foreign slots", () => {
    // This test exists to document the compile-time check. If someone adds
    // `{preference}` to ProgressCopySlot, this file will still compile but
    // the PII contract is broken — review proposals/2026-04-21 §2.2 N5 fold.
    const ok: ProgressCopyInterpolation = { day: "Tue", guest: "Josh" };
    expect(ok.day).toBe("Tue");
    // @ts-expect-error — 'preference' is not in the closed union
    const bad: ProgressCopyInterpolation = { preference: "no meetings after 4" };
    void bad;
  });
});
