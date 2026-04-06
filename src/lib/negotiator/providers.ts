import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ModelProvider } from "./types";

/**
 * Creates a model instance for the given provider.
 * Uses NEGOTIATOR_* env vars (separate from main app keys).
 * If apiKey is provided (BYO key), uses that instead.
 */
export function getModel(
  provider: ModelProvider,
  modelId: string,
  apiKey?: string
): LanguageModel {
  switch (provider) {
    case "anthropic": {
      const client = createAnthropic({
        apiKey: apiKey || process.env.NEGOTIATOR_ANTHROPIC_API_KEY || "",
      });
      return client(modelId) as unknown as LanguageModel;
    }
    case "google": {
      const client = createGoogleGenerativeAI({
        apiKey: apiKey || process.env.NEGOTIATOR_GOOGLE_AI_API_KEY || "",
      });
      return client(modelId) as unknown as LanguageModel;
    }
    case "openai": {
      const client = createOpenAI({
        apiKey: apiKey || process.env.NEGOTIATOR_OPENAI_API_KEY || "",
      });
      return client(modelId) as unknown as LanguageModel;
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
