import type { LanguageModelUsage } from "ai";

export type ModelTier = "fast" | "default" | "deep";

export const MODEL_TIERS: Record<ModelTier, string> = {
  fast: "claude-haiku-4-5-20251001",
  default: "claude-sonnet-4-6",
  deep: "claude-opus-4-7",
};

// Per-million-token pricing (USD). Cache read/write per Anthropic docs.
export const MODEL_PRICING: Record<
  string,
  {
    inputPer1M: number;
    outputPer1M: number;
    cacheReadPer1M: number;
    cacheWritePer1M: number;
  }
> = {
  "claude-haiku-4-5-20251001": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 1.25,
  },
  "claude-sonnet-4-6": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  "claude-opus-4-7": {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
  },
};

export type ModelSelection = {
  tier: ModelTier;
  modelId: string;
  reason: string;
};

export type TurnContext = {
  messageLength: number;
  // Reserved for future escalation signals (multi-session, deep rule edits, etc.)
  forceDeep?: boolean;
  forceFast?: boolean;
};

/**
 * Selects the appropriate model tier for a turn.
 *
 * v1 heuristics: conservative. Default (Sonnet 4.6) almost always.
 * Deep (Opus 4.7) only for explicitly long messages indicating complex intent.
 * Fast (Haiku) reserved for future sub-tasks (e.g. self-check pass).
 */
export function selectModelForTurn(ctx: TurnContext): ModelSelection {
  if (ctx.forceDeep) {
    return { tier: "deep", modelId: MODEL_TIERS.deep, reason: "forced-deep" };
  }
  if (ctx.forceFast) {
    return { tier: "fast", modelId: MODEL_TIERS.fast, reason: "forced-fast" };
  }
  // Escalate to Opus for genuinely long / complex messages
  if (ctx.messageLength > 500) {
    return {
      tier: "deep",
      modelId: MODEL_TIERS.deep,
      reason: "long-message-escalation",
    };
  }
  return { tier: "default", modelId: MODEL_TIERS.default, reason: "default" };
}

export type TurnCost = {
  model: string;
  tier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

/**
 * Computes per-turn cost from Vercel AI SDK usage object.
 * `usage.promptTokens` = input (non-cached) + cache-write.
 * Anthropic does not currently break these out in the AI SDK response, so we
 * treat the full promptTokens as input cost (slight overcount on cache-write
 * turns). Will refine if SDK exposes granular cache fields.
 */
export function computeTurnCost(
  usage: LanguageModelUsage,
  modelId: string,
  selection: ModelSelection,
): TurnCost {
  const pricing = MODEL_PRICING[modelId] ?? MODEL_PRICING[MODEL_TIERS.default];
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  // Cache fields are not yet exposed by the Vercel AI SDK wrapper — zero for now.
  const cacheReadTokens = 0;
  const cacheWriteTokens = 0;

  const costUsd =
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPer1M +
    (cacheWriteTokens / 1_000_000) * pricing.cacheWritePer1M;

  return {
    model: modelId,
    tier: selection.tier,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
  };
}
