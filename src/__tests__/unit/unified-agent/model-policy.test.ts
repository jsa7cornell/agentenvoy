import { describe, it, expect } from "vitest";
import type { LanguageModelUsage } from "ai";
import {
  selectModelForTurn,
  computeTurnCost,
  MODEL_TIERS,
  MODEL_PRICING,
} from "@/agent/unified/model-policy";

describe("selectModelForTurn — v4 flat length-based router (2026-05-14)", () => {
  // v4 policy (2026-05-14, cmp4u* triage):
  //   - messageLength > 500 → deep (Opus)
  //   - 200 < messageLength ≤ 500 → default (Sonnet)
  //   - messageLength ≤ 200 → fast (Haiku)
  //
  // The v3 multi-step + recency gates were retired after 14-day production
  // data showed they routed 64 sub-200-char turns to Sonnet for an avg
  // $0.063/turn with 16–20% remediation, while the 9 sub-200-char turns
  // that DID route to Haiku averaged $0.028/turn with 0–25% remediation —
  // Sonnet wasn't materially safer and the cost was ~2.3× higher. The
  // safety nets (self-check + post-stream guards + remediation pass) catch
  // genuine Haiku misroutes regardless of tier.
  //
  // The previous routing fields (priorToolUseInHistory, priorEnvoyTurnAgeMs,
  // priorTurnToolCount, priorEnvoyTurnCount) are kept on TurnContext for
  // telemetry continuity but no longer affect routing. Tests below pass them
  // in some cells to verify they're ignored.

  it("≤200 chars → fast (Haiku) regardless of priorToolUseInHistory", () => {
    // Pre-v4 this would have stayed on Sonnet because priorToolUseInHistory
    // fired the recency gate. v4 ignores the signal — short messages route
    // to Haiku unconditionally.
    const r = selectModelForTurn({
      messageLength: 50,
      priorToolUseInHistory: true,
      priorEnvoyTurnAgeMs: 5 * 60 * 1000, // 5 min — was "recent", now ignored
      priorEnvoyTurnCount: 5,
    });
    expect(r.tier).toBe("fast");
    expect(r.modelId).toBe(MODEL_TIERS.fast);
    expect(r.reason).toBe("short-message");
  });

  it("≤200 chars on a cold channel → fast (Haiku)", () => {
    const r = selectModelForTurn({ messageLength: 50, priorEnvoyTurnCount: 0 });
    expect(r.tier).toBe("fast");
  });

  it("≤200 chars right after a tool-using envoy turn (cmp4xju6z 'A' shape) → fast (Haiku)", () => {
    // The exact production case that motivated v4: the user replied "A" to
    // an ambiguity clarification right after a tool-using turn. v3 routed
    // this to Sonnet via the recency gate, paying $0.10 for a turn Haiku
    // would have handled. v4 routes "A" (or any sub-200-char message) to
    // Haiku regardless of how recent the prior tool use was.
    const r = selectModelForTurn({
      messageLength: 1, // "A"
      priorTurnToolCount: 2, // prior envoy turn used tools
      priorToolUseInHistory: true,
      priorEnvoyTurnAgeMs: 10 * 1000, // 10 seconds ago
      priorEnvoyTurnCount: 7,
    });
    expect(r.tier).toBe("fast");
    expect(r.reason).toBe("short-message");
  });

  it("exactly 200 chars → fast (boundary check; upper bound is inclusive)", () => {
    const r = selectModelForTurn({ messageLength: 200 });
    expect(r.tier).toBe("fast");
  });

  it("201 chars → default (Sonnet — just over the Haiku boundary)", () => {
    const r = selectModelForTurn({ messageLength: 201 });
    expect(r.tier).toBe("default");
    expect(r.reason).toBe("default");
  });

  it("500 chars → default (Sonnet — at the Opus boundary, still inclusive of Sonnet range)", () => {
    const r = selectModelForTurn({ messageLength: 500 });
    expect(r.tier).toBe("default");
  });

  it("501 chars → deep (Opus — just over the Sonnet boundary)", () => {
    const r = selectModelForTurn({ messageLength: 501 });
    expect(r.tier).toBe("deep");
    expect(r.modelId).toBe(MODEL_TIERS.deep);
    expect(r.reason).toBe("long-message-escalation");
  });

  it("forceDeep overrides length-based routing", () => {
    const r = selectModelForTurn({ messageLength: 10, forceDeep: true });
    expect(r.tier).toBe("deep");
    expect(r.reason).toBe("forced-deep");
  });

  it("forceFast overrides length-based routing (300 chars would normally be Sonnet)", () => {
    const r = selectModelForTurn({ messageLength: 300, forceFast: true });
    expect(r.tier).toBe("fast");
    expect(r.modelId).toBe(MODEL_TIERS.fast);
    expect(r.reason).toBe("forced-fast");
  });

  it("forceDeep takes precedence over forceFast when both set", () => {
    const r = selectModelForTurn({
      messageLength: 10,
      forceDeep: true,
      forceFast: true,
    });
    expect(r.tier).toBe("deep");
  });

  it("UA_DISABLE_HAIKU env var keeps short turns on Sonnet (kill switch)", () => {
    const prev = process.env.UA_DISABLE_HAIKU;
    process.env.UA_DISABLE_HAIKU = "true";
    try {
      const r = selectModelForTurn({ messageLength: 50 });
      expect(r.tier).toBe("default");
      expect(r.reason).toBe("haiku-disabled");
    } finally {
      if (prev === undefined) delete process.env.UA_DISABLE_HAIKU;
      else process.env.UA_DISABLE_HAIKU = prev;
    }
  });

  it("UA_DISABLE_HAIKU does NOT override forceDeep on a long message", () => {
    const prev = process.env.UA_DISABLE_HAIKU;
    process.env.UA_DISABLE_HAIKU = "true";
    try {
      const r = selectModelForTurn({ messageLength: 700, forceDeep: true });
      expect(r.tier).toBe("deep"); // forceDeep is highest-priority
    } finally {
      if (prev === undefined) delete process.env.UA_DISABLE_HAIKU;
      else process.env.UA_DISABLE_HAIKU = prev;
    }
  });

  it("v4 ignores priorEnvoyTurnCount entirely (cold vs. warm channel has no routing effect)", () => {
    const cold = selectModelForTurn({ messageLength: 50, priorEnvoyTurnCount: 0 });
    const warm = selectModelForTurn({ messageLength: 50, priorEnvoyTurnCount: 50 });
    expect(cold.tier).toBe("fast");
    expect(warm.tier).toBe("fast");
    expect(cold.reason).toBe(warm.reason);
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
