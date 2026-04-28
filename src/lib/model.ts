/**
 * Centralized model factory for core product AI calls.
 *
 * Routes through Vercel AI Gateway for unified observability and spend tracking.
 * BYOK keys (Anthropic/Google/OpenAI) are configured in the Vercel dashboard —
 * no provider keys needed in the app. Gateway auth uses AI_GATEWAY_API_KEY
 * (local dev) or OIDC (production on Vercel, automatic).
 *
 * The negotiator tool has its own provider system in lib/proposal-synthesizer/providers.ts
 * which also routes through the gateway for server-side calls.
 */

import { gateway } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * Returns a model instance for the given Anthropic model ID.
 *
 * In production and local dev, routes through Vercel AI Gateway.
 * When BENCH_DIRECT=1, bypasses the gateway and calls Anthropic directly
 * via ANTHROPIC_API_KEY — used by the bench harness to avoid gateway
 * rate limits on free-tier credits.
 */
export function envoyModel(modelId: string) {
  if (process.env.BENCH_DIRECT === "1") {
    return createAnthropic({ baseURL: "https://api.anthropic.com/v1" })(modelId);
  }
  return gateway(`anthropic/${modelId}`);
}
