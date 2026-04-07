import type { ModelProvider } from "./types";

export const PROVIDER_COLORS: Record<ModelProvider, string> = {
  anthropic: "border-orange-500/40 bg-orange-500/5",
  google: "border-blue-500/40 bg-blue-500/5",
  openai: "border-green-500/40 bg-green-500/5",
};

export const PROVIDER_DOT: Record<ModelProvider, string> = {
  anthropic: "bg-orange-500",
  google: "bg-blue-500",
  openai: "bg-green-500",
};
