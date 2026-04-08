/**
 * Centralized model factory for core product AI calls.
 *
 * Uses ENVOY_ANTHROPIC_API_KEY for the default Anthropic provider.
 * All core product code (administrator, channel chat, dashboard chat,
 * scoring, evals) should import from here instead of @ai-sdk/* directly.
 *
 * The negotiator tool has its own provider system in lib/negotiator/providers.ts
 * with separate NEGOTIATOR_* keys.
 */

import { createAnthropic } from "@ai-sdk/anthropic";

const envoyAnthropic = createAnthropic({
  apiKey: process.env.ENVOY_ANTHROPIC_API_KEY,
});

/**
 * Returns a model instance for the given model ID.
 * Currently Anthropic-only; multi-provider support planned.
 */
export function envoyModel(modelId: string) {
  if (!process.env.ENVOY_ANTHROPIC_API_KEY) {
    throw new Error("Missing ENVOY_ANTHROPIC_API_KEY");
  }
  return envoyAnthropic(modelId);
}
