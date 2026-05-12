import { describe, it, expect } from "vitest";
import type { LanguageModelUsage } from "ai";
import {
  selectModelForTurn,
  computeTurnCost,
  MODEL_TIERS,
  MODEL_PRICING,
} from "@/agent/unified/model-policy";

describe("selectModelForTurn", () => {
  // v3 policy (recency-window gate, 2026-05-12):
  //   short (≤200) + no multi-step + no recent prior tool use → fast (Haiku)
  //   long (>500) → deep (Opus)
  //   else → default (Sonnet)
  // Recency window splits "in-flight" from "stale history": prior tool use
  // ≤15 min ago keeps Sonnet (real mid-flow), >15 min ago drops to Haiku
  // (dead history, the case-study turn shape).

  // Helper for the established-channel default state.
  const established = { priorEnvoyTurnCount: 5 } as const;
  const RECENT_AGE_MS = 5 * 60 * 1000; // 5 min — inside the 15-min window
  const STALE_AGE_MS = 8 * 60 * 60 * 1000; // 8h — well outside the window

  it("returns fast (Haiku) for short messages with no multi-step on established channel", () => {
    const r = selectModelForTurn({ messageLength: 50, ...established });
    expect(r.tier).toBe("fast");
    expect(r.modelId).toBe(MODEL_TIERS.fast);
    expect(r.reason).toBe("short-no-multistep");
  });

  it("returns fast (Haiku) on cold channels for short messages (gate loosened)", () => {
    // First-ever turn — no history. With grounding-check + self-check covering
    // load-bearing creates, short cold-channel turns now route to Haiku.
    const r = selectModelForTurn({ messageLength: 50, priorEnvoyTurnCount: 0 });
    expect(r.tier).toBe("fast");
    expect(r.reason).toBe("short-no-multistep");
  });

  it("returns fast (Haiku) on near-cold channels with only 1 prior envoy turn", () => {
    const r = selectModelForTurn({ messageLength: 50, priorEnvoyTurnCount: 1 });
    expect(r.tier).toBe("fast");
  });

  it("returns fast at exactly 2 prior envoy turns", () => {
    const r = selectModelForTurn({ messageLength: 50, priorEnvoyTurnCount: 2 });
    expect(r.tier).toBe("fast");
  });

  it("returns default (Sonnet) for short messages when prior tool use is recent (in-flight)", () => {
    // The original safety case: user said "yes" 5 min after a LOAD proposal.
    const r = selectModelForTurn({
      messageLength: 50,
      priorToolUseInHistory: true,
      priorEnvoyTurnAgeMs: RECENT_AGE_MS,
      ...established,
    });
    expect(r.tier).toBe("default");
    expect(r.reason).toBe("default");
  });

  it("returns default (Sonnet) when priorToolUseInHistory but ageMs is unknown (conservative)", () => {
    // Pre-recency callers (and tests that omit ageMs) preserve the v2
    // behavior: any prior tool use → Sonnet. Runner always passes ageMs;
    // this guards against partial migrations.
    const r = selectModelForTurn({
      messageLength: 50,
      priorToolUseInHistory: true,
      ...established,
    });
    expect(r.tier).toBe("default");
  });

  it("returns fast (Haiku) when prior tool use was >15 min ago (stale history — case-study turn)", () => {
    // The case-study turn: 8h 40min after a personal_link_update on an
    // unrelated topic. v2 gate kept this on Sonnet → 24s / $0.09 for "protect
    // my calendar next monday all day". v3 routes it to Haiku.
    const r = selectModelForTurn({
      messageLength: 40, // "protect my calendar next monday all day"
      priorToolUseInHistory: true,
      priorEnvoyTurnAgeMs: STALE_AGE_MS,
      ...established,
    });
    expect(r.tier).toBe("fast");
    expect(r.reason).toBe("short-stale-history");
  });

  it("returns fast (Haiku) when prior tool use is exactly at the recency boundary (15 min)", () => {
    // Boundary check: 15 min ages out, 14:59 stays in.
    const exactly15Min = 15 * 60 * 1000;
    const r = selectModelForTurn({
      messageLength: 50,
      priorToolUseInHistory: true,
      priorEnvoyTurnAgeMs: exactly15Min + 1,
      ...established,
    });
    expect(r.tier).toBe("fast");
    expect(r.reason).toBe("short-stale-history");
  });

  it("returns default (Sonnet) when prior envoy turn used tools (priorTurnToolCount)", () => {
    // Mid-flow case: user just said "yes" after a LOAD proposal — the prior
    // envoy turn itself made tool calls. priorTurnToolCount overrides recency.
    const r = selectModelForTurn({
      messageLength: 5,
      priorTurnToolCount: 2,
      priorEnvoyTurnAgeMs: STALE_AGE_MS, // even with stale age, in-flight wins
      ...established,
    });
    expect(r.tier).toBe("default");
  });

  it("returns fast at exactly 200 chars (the upper boundary)", () => {
    const r = selectModelForTurn({ messageLength: 200, ...established });
    expect(r.tier).toBe("fast");
  });

  it("returns default for medium messages above the Haiku ceiling (>200, ≤500)", () => {
    const r = selectModelForTurn({ messageLength: 201, ...established });
    expect(r.tier).toBe("default");
  });

  it("returns default for messages at the deep-escalation boundary (500)", () => {
    const r = selectModelForTurn({ messageLength: 500, ...established });
    expect(r.tier).toBe("default");
  });

  it("escalates to deep for messages over 500 chars", () => {
    const r = selectModelForTurn({ messageLength: 501, ...established });
    expect(r.tier).toBe("deep");
    expect(r.modelId).toBe(MODEL_TIERS.deep);
  });

  it("forceDeep overrides length heuristic", () => {
    const r = selectModelForTurn({ messageLength: 10, forceDeep: true });
    expect(r.tier).toBe("deep");
    expect(r.reason).toBe("forced-deep");
  });

  it("forceFast overrides default selection", () => {
    const r = selectModelForTurn({ messageLength: 300, forceFast: true });
    expect(r.tier).toBe("fast");
    expect(r.modelId).toBe(MODEL_TIERS.fast);
    expect(r.reason).toBe("forced-fast");
  });

  it("forceDeep takes precedence over forceFast when both set", () => {
    const r = selectModelForTurn({ messageLength: 10, forceDeep: true, forceFast: true });
    expect(r.tier).toBe("deep");
  });

  it("UA_DISABLE_HAIKU env var keeps short turns on Sonnet (kill switch)", () => {
    const prev = process.env.UA_DISABLE_HAIKU;
    process.env.UA_DISABLE_HAIKU = "true";
    try {
      const r = selectModelForTurn({ messageLength: 50, ...established });
      expect(r.tier).toBe("default");
      expect(r.reason).toBe("haiku-disabled");
    } finally {
      if (prev === undefined) delete process.env.UA_DISABLE_HAIKU;
      else process.env.UA_DISABLE_HAIKU = prev;
    }
  });
});

describe("computeTurnCost", () => {
  // Use a medium-length message to land on Sonnet for the cost-arithmetic tests.
  const defaultSelection = selectModelForTurn({ messageLength: 250 });

  it("computes zero cost for zero-token usage", () => {
    const cost = computeTurnCost(
      { inputTokens: 0, outputTokens: 0 } as LanguageModelUsage,
      MODEL_TIERS.default,
      defaultSelection,
    );
    expect(cost.costUsd).toBe(0);
    expect(cost.inputTokens).toBe(0);
    expect(cost.outputTokens).toBe(0);
  });

  it("computes correct Sonnet cost for 1000 input + 200 output tokens", () => {
    const cost = computeTurnCost(
      { inputTokens: 1000, outputTokens: 200 } as LanguageModelUsage,
      MODEL_TIERS.default,
      defaultSelection,
    );
    const pricing = MODEL_PRICING[MODEL_TIERS.default];
    const expected =
      (1000 / 1_000_000) * pricing.inputPer1M +
      (200 / 1_000_000) * pricing.outputPer1M;
    expect(cost.costUsd).toBeCloseTo(expected, 8);
    expect(cost.tier).toBe("default");
    expect(cost.model).toBe(MODEL_TIERS.default);
  });

  it("falls back to Sonnet pricing for unknown modelId", () => {
    const cost = computeTurnCost(
      { inputTokens: 1000, outputTokens: 100 } as LanguageModelUsage,
      "claude-unknown-model",
      defaultSelection,
    );
    const pricing = MODEL_PRICING[MODEL_TIERS.default];
    const expected =
      (1000 / 1_000_000) * pricing.inputPer1M +
      (100 / 1_000_000) * pricing.outputPer1M;
    expect(cost.costUsd).toBeCloseTo(expected, 8);
  });

  it("computes Haiku cost correctly (cheaper than Sonnet)", () => {
    const fastSelection = selectModelForTurn({ messageLength: 10, forceFast: true });
    const haikuCost = computeTurnCost(
      { inputTokens: 1000, outputTokens: 200 } as LanguageModelUsage,
      MODEL_TIERS.fast,
      fastSelection,
    );
    const sonnetCost = computeTurnCost(
      { inputTokens: 1000, outputTokens: 200 } as LanguageModelUsage,
      MODEL_TIERS.default,
      defaultSelection,
    );
    expect(haikuCost.costUsd).toBeLessThan(sonnetCost.costUsd);
  });

  it("defaults cache fields to zero when SDK omits inputTokenDetails", () => {
    const cost = computeTurnCost(
      { inputTokens: 5000, outputTokens: 500 } as LanguageModelUsage,
      MODEL_TIERS.default,
      defaultSelection,
    );
    expect(cost.cacheReadTokens).toBe(0);
    expect(cost.cacheWriteTokens).toBe(0);
  });

  it("bills cached input correctly: read tokens at 0.1× rate, non-cached at full rate", () => {
    // Total 1000 input tokens; 800 came from cache read, 200 fresh, 0 write.
    const cost = computeTurnCost(
      {
        inputTokens: 1000,
        outputTokens: 200,
        inputTokenDetails: {
          noCacheTokens: 200,
          cacheReadTokens: 800,
          cacheWriteTokens: 0,
        },
      } as LanguageModelUsage,
      MODEL_TIERS.default,
      defaultSelection,
    );
    const pricing = MODEL_PRICING[MODEL_TIERS.default];
    const expected =
      (200 / 1_000_000) * pricing.inputPer1M +          // 200 fresh input
      (800 / 1_000_000) * pricing.cacheReadPer1M +      // 800 cache read
      (200 / 1_000_000) * pricing.outputPer1M;          // 200 output
    expect(cost.costUsd).toBeCloseTo(expected, 8);
    expect(cost.cacheReadTokens).toBe(800);
    expect(cost.inputTokens).toBe(200); // non-cached only
  });

  it("bills cache write correctly: 1.25× multiplier on first turn", () => {
    // First turn: 0 read, 800 write, 200 fresh.
    const cost = computeTurnCost(
      {
        inputTokens: 1000,
        outputTokens: 100,
        inputTokenDetails: {
          noCacheTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 800,
        },
      } as LanguageModelUsage,
      MODEL_TIERS.default,
      defaultSelection,
    );
    const pricing = MODEL_PRICING[MODEL_TIERS.default];
    const expected =
      (200 / 1_000_000) * pricing.inputPer1M +
      (800 / 1_000_000) * pricing.cacheWritePer1M +
      (100 / 1_000_000) * pricing.outputPer1M;
    expect(cost.costUsd).toBeCloseTo(expected, 8);
    expect(cost.cacheWriteTokens).toBe(800);
  });
});
