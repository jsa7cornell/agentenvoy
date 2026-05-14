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
 * tool use. 15 min covered the realistic "user got coffee mid-flow" case
 * without stranding genuinely fresh interactions on Sonnet.
 *
 * **2026-05-14 (v4):** the constant was removed. The router no longer
 * consults priorEnvoyTurnAgeMs. Documented here as institutional memory:
 * if a v5 ever wants to bring this gate back, the prior value was 15 min
 * (15 * 60 * 1000 ms). See selectModelForTurn for the v4 contract.
 */

/**
 * Selects the appropriate model tier for a turn.
 *
 * **Tier policy (v4 — flat length-based router, 2026-05-14):**
 *   - **Opus** when message > 500 chars or `forceDeep`. Genuinely complex.
 *   - **Sonnet** when message > 200 chars. Multi-constraint, multi-step shapes.
 *   - **Haiku** otherwise (≤ 200 chars). Acks, confirmations, single-shot
 *     reads, simple write requests. Most production traffic.
 *
 * Why the simpler rule replaced v3's recency-window + multi-step gate:
 *
 * 14-day production data (cmp4u* triage thread, 2026-05-14) showed the
 * v3 router routed 64 sub-200-char turns to Sonnet via the recency gate,
 * averaging $0.063/turn with a 16-20% remediation rate. The 9 sub-200-char
 * turns that DID route to Haiku in the same window averaged $0.028/turn
 * with 0-25% remediation. Sonnet wasn't materially safer on this bucket,
 * and the cost difference was a clear ~50% reduction available by routing
 * by length alone.
 *
 * The conservatism the v3 router added — "if any tool fired in the last
 * 15 min, keep Sonnet just in case" — was conservatism without empirical
 * support. The safety nets that catch genuine Haiku misroutes
 * (`runSelfCheck` + post-stream guards + the remediation pass) earn
 * their keep regardless of tier, and were already absorbing the
 * tier-switch cases the router was trying to prevent.
 *
 * Bonus win: the simpler rule eliminates the Haiku → Sonnet tier-switch
 * mid-conversation, which was paying a fresh per-model cache write
 * (22k tokens × $3.75/MTok = ~$0.086 every time). The simple rule keeps
 * a conversation on one tier unless the message itself crosses the
 * length boundary.
 *
 * Operational levers preserved:
 *   - `forceDeep` / `forceFast` — per-call escalation/demotion.
 *   - `UA_DISABLE_HAIKU=true` env — kill-switch routes every turn to
 *     Sonnet without a redeploy if Haiku regresses.
 *
 * TurnContext fields not used by this version (priorToolUseInHistory,
 * priorEnvoyTurnAgeMs, priorTurnToolCount, priorEnvoyTurnCount) are kept
 * in the type for telemetry continuity — `runUnifiedTurn` still gathers
 * them and persists them on the message metadata. Re-introducing them
 * as router gates would be a v5 if production data shows the simpler
 * rule misroutes a specific shape; today's data says it doesn't.
 */
export function selectModelForTurn(ctx: TurnContext): ModelSelection {
  if (ctx.forceDeep) {
    return { tier: "deep", modelId: MODEL_TIERS.deep, reason: "forced-deep" };
  }
  if (ctx.forceFast) {
    return { tier: "fast", modelId: MODEL_TIERS.fast, reason: "forced-fast" };
  }
  // Operational kill-switch: setting UA_DISABLE_HAIKU=true keeps every turn
  // on Sonnet without a redeploy. Use if Haiku produces a regression.
  if (process.env.UA_DISABLE_HAIKU === "true") {
    return { tier: "default", modelId: MODEL_TIERS.default, reason: "haiku-disabled" };
  }
  // Length-based router (v4).
  if (ctx.messageLength > 500) {
    return { tier: "deep", modelId: MODEL_TIERS.deep, reason: "long-message-escalation" };
  }
  if (ctx.messageLength > 200) {
    return { tier: "default", modelId: MODEL_TIERS.default, reason: "default" };
  }
  return { tier: "fast", modelId: MODEL_TIERS.fast, reason: "short-message" };
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
