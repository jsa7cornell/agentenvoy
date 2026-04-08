import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { gateway } from "ai";
import type { LanguageModel } from "ai";
import type { ModelProvider } from "./types";

/**
 * Creates a model instance for the given provider.
 *
 * When apiKey is provided (BYO key from client), uses a direct provider connection.
 * When no apiKey, routes through Vercel AI Gateway — BYOK keys configured in
 * Vercel dashboard handle provider auth with zero markup.
 */
export function getModel(
  provider: ModelProvider,
  modelId: string,
  apiKey?: string
): LanguageModel {
  // BYO key from client — use direct provider connection, bypass gateway
  if (apiKey) {
    switch (provider) {
      case "anthropic": {
        const client = createAnthropic({ apiKey });
        return client(modelId) as unknown as LanguageModel;
      }
      case "google": {
        const client = createGoogleGenerativeAI({ apiKey });
        return client(modelId) as unknown as LanguageModel;
      }
      case "openai": {
        const client = createOpenAI({ apiKey });
        return client(modelId) as unknown as LanguageModel;
      }
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  // Server-side — route through AI Gateway for observability
  return gateway(`${provider}/${modelId}`) as unknown as LanguageModel;
}
