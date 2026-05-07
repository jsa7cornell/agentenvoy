import { describe, it, expect } from "vitest";
import type { LanguageModelUsage } from "ai";
import {
  selectModelForTurn,
  computeTurnCost,
  MODEL_TIERS,
  MODEL_PRICING,
} from "@/agent/unified/model-policy";

describe("selectModelForTurn", () => {
  // v2 policy (cost-reduction PR 2026-05-07):
  //   short (≤200) + no multi-step → fast (Haiku)
  //   long (>500) → deep (Opus)
  //   else → default (Sonnet)

  it("returns fast (Haiku) for short messages with no multi-step in progress", () => {
    const r = selectModelForTurn({ messageLength: 50 });
    expect(r.tier).toBe("fast");
    expect(r.modelId).toBe(MODEL_TIERS.fast);
    expect(r.reason).toBe("short-no-multistep");
  });

  it("returns default (Sonnet) for short messages when prior tool use is in history", () => {
    const r = selectModelForTurn({ messageLength: 50, priorToolUseInHistory: true });
    expect(r.tier).toBe("default");
  });

  it("returns default for medium messages above the Haiku ceiling (>200, ≤500)", () => {
    const r = selectModelForTurn({ messageLength: 201 });
    expect(r.tier).toBe("default");
  });

  it("returns default for messages at the deep-escalation boundary (500)", () => {
    const r = selectModelForTurn({ messageLength: 500 });
    expect(r.tier).toBe("default");
  });

  it("escalates to deep for messages over 500 chars", () => {
    const r = selectModelForTurn({ messageLength: 501 });
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

  it("cache fields are zero in v1 (SDK does not expose them yet)", () => {
    const cost = computeTurnCost(
      { inputTokens: 5000, outputTokens: 500 } as LanguageModelUsage,
      MODEL_TIERS.default,
      defaultSelection,
    );
    expect(cost.cacheReadTokens).toBe(0);
    expect(cost.cacheWriteTokens).toBe(0);
  });
});
