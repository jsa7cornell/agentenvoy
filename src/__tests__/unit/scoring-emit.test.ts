/**
 * scoring-emit — wire-emit derivation tests.
 *
 * Per the 2026-05-01 event-availability-vs-preferred-vs-calendar-scoring
 * proposal: `slot.score` is host-stable; the wire-emit integer + boolean
 * are derived per-call by `deriveEmittedScore` / `deriveEmittedPreferred`.
 *
 * These tests pin the core derivation rules (single source of truth)
 * and catch drift between the three emission sites that import them
 * (`mcp/tools.ts`, `mcp/host-tools.ts`, `agent-snapshot.ts`).
 *
 * Snapshot tests across the four canonical link shapes from the
 * proposal's §G live with the proposal-decided implementer's harness;
 * this file is the focused unit-level coverage MCP requires per the
 * 2026-05-01 MCP-handoff Task 4.
 */
import { describe, it, expect } from "vitest";
import {
  deriveEmittedScore,
  deriveEmittedPreferred,
} from "@/lib/scoring-emit";
import type { ScoredSlot, LinkParameters } from "@/lib/scoring";

const TZ = "America/Los_Angeles";

function mkSlot(overrides: Partial<ScoredSlot> = {}): ScoredSlot {
  // Wed 2026-05-06 10:00 PT = 17:00 UTC
  return {
    start: "2026-05-06T17:00:00.000Z",
    end: "2026-05-06T17:30:00.000Z",
    score: 0,
    confidence: "high",
    reason: "",
    kind: "open",
    blockCost: "none",
    ...overrides,
  } as ScoredSlot;
}

describe("deriveEmittedScore — empty rules", () => {
  it("returns the unmutated score when no per-link rules are set", () => {
    const s = mkSlot({ score: 0 });
    expect(deriveEmittedScore(s, {} as LinkParameters, TZ)).toBe(0);
  });

  it("preserves -2/-1/0/1/2/3 unchanged with empty rules", () => {
    const empty = {} as LinkParameters;
    for (const score of [-2, -1, 0, 1, 2, 3]) {
      expect(deriveEmittedScore(mkSlot({ score }), empty, TZ)).toBe(score);
    }
  });
});

describe("deriveEmittedPreferred — empty rules", () => {
  it("returns false for any score when no per-link rules are set", () => {
    const empty = {} as LinkParameters;
    // Critical behavior change from pre-2026-05-01: a slot with score -1
    // is NOT preferred without a per-link rule. Preferred is now membership-
    // based, not score-based. Documented per SPEC §8.
    expect(deriveEmittedPreferred(mkSlot({ score: -1 }), empty, TZ)).toBe(false);
    expect(deriveEmittedPreferred(mkSlot({ score: 0 }), empty, TZ)).toBe(false);
    expect(deriveEmittedPreferred(mkSlot({ score: 1 }), empty, TZ)).toBe(false);
  });
});

describe("deriveEmittedPreferred — preferred.days membership", () => {
  it("Wed slot in preferred.days: ['Wed'] → preferred: true", () => {
    const slot = mkSlot();  // Wed 10am PT
    const rules = { preferred: { days: ["Wed"] } } as LinkParameters;
    expect(deriveEmittedPreferred(slot, rules, TZ)).toBe(true);
  });

  it("Tue slot with preferred.days: ['Wed'] → preferred: false", () => {
    // Tue 2026-05-05 10:00 PT
    const slot = mkSlot({
      start: "2026-05-05T17:00:00.000Z",
      end: "2026-05-05T17:30:00.000Z",
    });
    const rules = { preferred: { days: ["Wed"] } } as LinkParameters;
    expect(deriveEmittedPreferred(slot, rules, TZ)).toBe(false);
  });
});

describe("deriveEmittedScore — preferred.days promotion", () => {
  it("Wed slot in preferred.days promotes to score: -1", () => {
    const slot = mkSlot({ score: 0 });  // Wed 10am, base score 0
    const rules = { preferred: { days: ["Wed"] } } as LinkParameters;
    expect(deriveEmittedScore(slot, rules, TZ)).toBe(-1);
  });

  it("non-Wed slot leaves score unchanged with preferred.days: ['Wed']", () => {
    const slot = mkSlot({
      start: "2026-05-05T17:00:00.000Z",  // Tue
      end: "2026-05-05T17:30:00.000Z",
      score: 0,
    });
    const rules = { preferred: { days: ["Wed"] } } as LinkParameters;
    expect(deriveEmittedScore(slot, rules, TZ)).toBe(0);
  });
});

describe("deriveEmittedScore — restrictToSlots is exclusive (-2)", () => {
  it("slot in availability.restrictToSlots emits -2 (host pinned)", () => {
    const slot = mkSlot();
    const rules = {
      availability: {
        restrictToSlots: [
          { start: "2026-05-06T17:00:00.000Z", end: "2026-05-06T17:30:00.000Z" },
        ],
      },
    } as unknown as LinkParameters;
    expect(deriveEmittedScore(slot, rules, TZ)).toBe(-2);
  });

  it("preferred-via-restrictToSlots also emits preferred: true", () => {
    const slot = mkSlot();
    const rules = {
      availability: {
        restrictToSlots: [
          { start: "2026-05-06T17:00:00.000Z", end: "2026-05-06T17:30:00.000Z" },
        ],
      },
    } as unknown as LinkParameters;
    expect(deriveEmittedPreferred(slot, rules, TZ)).toBe(true);
  });
});

describe("deriveEmittedScore — restrictToSlots wins over preferred.days", () => {
  it("slot in BOTH restrictToSlots AND preferred.days emits -2 (restrict wins)", () => {
    const slot = mkSlot();
    const rules = {
      availability: {
        restrictToSlots: [
          { start: "2026-05-06T17:00:00.000Z", end: "2026-05-06T17:30:00.000Z" },
        ],
      },
      preferred: { days: ["Wed"] },
    } as unknown as LinkParameters;
    // Rule 1 (restrictToSlots) wins over Rule 2 (preferred) in the
    // first-match-wins ladder per scoring-emit.ts.
    expect(deriveEmittedScore(slot, rules, TZ)).toBe(-2);
  });
});
