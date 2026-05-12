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
   *  Combined with `priorEnvoyTurnAgeMs` to gate Haiku against in-flight
   *  multi-step flows. */
  priorToolUseInHistory?: boolean;
  /** Wall-clock ms since the most recent prior envoy turn was persisted.
   *  Combined with `priorToolUseInHistory` to detect a still-in-flight tool
   *  sequence vs. dead history: only keep Sonnet when the prior tool-using
   *  turn is recent enough (≤ HAIKU_RECENCY_WINDOW_MS) to plausibly be the
   *  same interaction. 8h+ gaps fall through to Haiku regardless. Undefined
   *  ageMs is treated as "unknown" → conservative (preserves pre-recency
   *  behavior). */
  priorEnvoyTurnAgeMs?: number;
  /** Number of prior envoy turns in history. Retained for telemetry/back-compat;
   *  no longer gates Haiku routing (grounding-check + self-check cover the
   *  load-bearing-create concern that previously kept cold channels on Sonnet). */
  priorEnvoyTurnCount?: number;
  // Reserved for future escalation signals (multi-session, deep rule edits, etc.)
  forceDeep?: boolean;
  forceFast?: boolean;
};

/**
 * If the most recent prior envoy turn used tools AND was within this window,
 * we treat this turn as plausibly still in-flight and keep Sonnet. Beyond it,
 * the conversation is cold — short messages route to Haiku even after prior
 * tool use. 15 min covers the realistic "user got coffee mid-flow" case
 * without stranding genuinely fresh interactions on Sonnet.
 */
const HAIKU_RECENCY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Selects the appropriate model tier for a turn.
 *
 * Tier policy (v3 — recency-window gate, 2026-05-12):
 *   - **Opus** when the message is long (>500 chars) or `forceDeep`. Genuinely
 *     complex intents that benefit from deeper reasoning.
 *   - **Haiku** when the message is short (≤200 chars) AND there's no recent
 *     multi-step flow. Confirmations, simple acks, single-shot reads — Haiku
 *     handles these fine and costs ~3x less.
 *   - **Sonnet** for everything else (default tier — most tool-using turns).
 *
 * Why the multi-step gate matters: if the host says "yes" mid-flow after a
 * `LOAD_active_sessions` proposal, dropping to Haiku risks losing tool-routing
 * accuracy. The v2 (2026-05-07) gate keyed on `priorToolUseInHistory` alone,
 * which fired on ANY prior tool use anywhere in the 10-turn window — including
 * 8h+ stale ones. v3 splits "in-flight" from "ever happened" using
 * `priorEnvoyTurnAgeMs`: prior tool use within HAIKU_RECENCY_WINDOW_MS still
 * keeps Sonnet (real in-flight case); older than that drops to Haiku.
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
  // Multi-step gate (v3 — recency-aware):
  //   - `priorTurnToolCount > 0`: the turn immediately before this one used tools
  //     → still mid-flow → keep Sonnet.
  //   - `priorToolUseInHistory` AND prior envoy turn was recent (<window) →
  //     in-flight likely → keep Sonnet.
  //   - `priorToolUseInHistory` AND age unknown → conservative, keep Sonnet
  //     (preserves pre-recency behavior for callers that don't pass ageMs).
  //   - `priorToolUseInHistory` AND age > window → dead history → route to Haiku.
  //   - No prior tool use → route to Haiku.
  const inMultiStep = !!ctx.priorTurnToolCount;
  const recentPriorToolUse =
    !!ctx.priorToolUseInHistory &&
    (typeof ctx.priorEnvoyTurnAgeMs !== "number" ||
      ctx.priorEnvoyTurnAgeMs <= HAIKU_RECENCY_WINDOW_MS);
  if (ctx.messageLength <= 200 && !inMultiStep && !recentPriorToolUse) {
    // Distinguish "stale prior tool use, recency dropped us through" from
    // "no prior tool use ever" so production telemetry can show the v3 gate
    // earning its keep.
    const reason = ctx.priorToolUseInHistory
      ? "short-stale-history"
      : "short-no-multistep";
    return {
      tier: "fast",
      modelId: MODEL_TIERS.fast,
      reason,
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
