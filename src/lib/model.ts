/**
 * Centralized model factory for core product AI calls.
 *
 * Routes through Vercel AI Gateway for unified observability and spend tracking.
 * BYOK keys (Anthropic/Google/OpenAI) are configured in the Vercel dashboard —
 * no provider keys needed in the app. Gateway auth uses AI_GATEWAY_API_KEY
 * (local dev) or OIDC (production on Vercel, automatic).
 *
 * The negotiator tool has its own provider system in lib/negotiator/providers.ts
 * which also routes through the gateway for server-side calls.
 */

import { gateway } from "ai";

/**
 * Returns a gateway model instance for the given Anthropic model ID.
 */
export function envoyModel(modelId: string) {
  return gateway(`anthropic/${modelId}`);
}
