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
  /** Number of tool calls in the most recent envoy turn. Used to detect
   *  multi-step flow in progress; we keep Sonnet for those even on short turns. */
  priorTurnToolCount?: number;
  /** Whether any prior envoy turn in the loaded history made a tool call.
   *  Conservative gate to avoid Haiku stepping into the middle of a tool sequence. */
  priorToolUseInHistory?: boolean;
  /** Number of prior envoy turns in history. Used to recognize cold channels
   *  (first-turn-ever) where complex create-link requests should stay on Sonnet
   *  even when short, since there's no context to disambiguate. */
  priorEnvoyTurnCount?: number;
  // Reserved for future escalation signals (multi-session, deep rule edits, etc.)
  forceDeep?: boolean;
  forceFast?: boolean;
};

/** Minimum prior envoy turns before we trust the multi-step gate enough to
 *  route to Haiku. Cold channels stay on Sonnet — first-ever turns are often
 *  load-bearing creates ("create music lessons link M/T 3-5") that shouldn't
 *  go to Haiku just because they happen to be short. */
const COLD_CHANNEL_MIN_HISTORY = 2;

/**
 * Selects the appropriate model tier for a turn.
 *
 * Tier policy (v2 — cost-reduction PR 2026-05-07):
 *   - **Opus** when the message is long (>500 chars) or `forceDeep`. Genuinely
 *     complex intents that benefit from deeper reasoning.
 *   - **Haiku** when the message is short (≤200 chars) AND there's no recent
 *     multi-step flow. Confirmations, simple acks, single-shot reads — Haiku
 *     handles these fine and costs ~3x less.
 *   - **Sonnet** for everything else (default tier — most tool-using turns).
 *
 * Why the multi-step gate matters: if a user says "yes" mid-flow after a
 * `LOAD_active_sessions` proposal, dropping to Haiku risks losing tool-routing
 * accuracy for the follow-up. Stay on Sonnet whenever there's a tool sequence
 * in progress.
 */
export function selectModelForTurn(ctx: TurnContext): ModelSelection {
  if (ctx.forceDeep) {
    return { tier: "deep", modelId: MODEL_TIERS.deep, reason: "forced-deep" };
  }
  if (ctx.forceFast) {
    return { tier: "fast", modelId: MODEL_TIERS.fast, reason: "forced-fast" };
  }
  // Escalate to Opus for genuinely long / complex messages.
  if (ctx.messageLength > 500) {
    return {
      tier: "deep",
      modelId: MODEL_TIERS.deep,
      reason: "long-message-escalation",
    };
  }
  // Operational kill-switch: setting UA_DISABLE_HAIKU=true in Vercel env keeps
  // every turn on Sonnet without a redeploy. Use if Haiku produces a regression
  // we need to revert immediately. Caching + tool trim + history cut still
  // apply; only the tier router falls back.
  if (process.env.UA_DISABLE_HAIKU === "true") {
    return { tier: "default", modelId: MODEL_TIERS.default, reason: "haiku-disabled" };
  }
  // Drop to Haiku for short turns when no multi-step flow is in progress AND
  // the channel has enough history to be confident the gate is meaningful.
  // The 200-char threshold catches confirmations ("go for it", "yes please"),
  // simple acks, and single-shot questions while leaving room for short
  // create-link asks ("schedule coffee with Susan tomorrow") on Sonnet.
  // Cold channels (first-ever turns) stay on Sonnet — see COLD_CHANNEL_MIN_HISTORY.
  const noMultiStep =
    !ctx.priorTurnToolCount &&
    !ctx.priorToolUseInHistory;
  const hasEstablishedHistory =
    (ctx.priorEnvoyTurnCount ?? 0) >= COLD_CHANNEL_MIN_HISTORY;
  if (ctx.messageLength <= 200 && noMultiStep && hasEstablishedHistory) {
    return {
      tier: "fast",
      modelId: MODEL_TIERS.fast,
      reason: "short-no-multistep",
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
 *
 * The SDK's `usage.inputTokens` is the TOTAL prompt tokens including cache
 * read/write portions. We split out cache reads/writes so each is priced at
 * its own rate, and bill the remainder as non-cached input.
 *
 * Anthropic prompt caching pricing (per Anthropic docs):
 *   - cache-write tokens: same rate as input × 1.25
 *   - cache-read tokens: same rate as input × 0.1
 *   - non-cached input: standard input rate
 *
 * Cache-tracking enabled 2026-05-07 in the cost-reduction PR; prior turns'
 * persisted cost rows show non-cached pricing (cacheReadTokens=0).
 */
export function computeTurnCost(
  usage: LanguageModelUsage,
  modelId: string,
  selection: ModelSelection,
): TurnCost {
  const pricing = MODEL_PRICING[modelId] ?? MODEL_PRICING[MODEL_TIERS.default];
  const totalInput = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  // Non-cached input is whatever's left after subtracting cache reads/writes.
  // Clamp to 0 in case the SDK reports inconsistent totals.
  const inputTokens = Math.max(0, totalInput - cacheReadTokens - cacheWriteTokens);

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
