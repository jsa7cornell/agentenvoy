// ─── Provider / Model ─────────────────────────────────────

export type ModelProvider = "anthropic" | "google" | "openai";

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
};

// Default for all new agents — cheapest available
export const DEFAULT_MODEL = "gpt-4o-mini";

export const DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
};

export const MODEL_OPTIONS: Record<ModelProvider, string[]> = {
  anthropic: [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  google: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ],
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1"],
};

// ─── Model Pricing ($ per 1M tokens) ──────────────────────
// Source: official pricing pages, April 2026
export interface ModelPricing {
  input: number;  // $ per 1M input tokens
  output: number; // $ per 1M output tokens
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o-mini":       { input: 0.15,  output: 0.60  },
  "gemini-2.5-flash":  { input: 0.30,  output: 2.50  },
  "claude-haiku-4-5":  { input: 1.00,  output: 5.00  },
  "o3-mini":           { input: 1.10,  output: 4.40  },
  "gemini-2.5-pro":    { input: 1.25,  output: 10.00 },
  "claude-sonnet-4-6": { input: 3.00,  output: 15.00 },
  "gpt-4o":            { input: 2.50,  output: 10.00 },
  "claude-opus-4-6":   { input: 5.00,  output: 25.00 },
  "o1":                { input: 15.00, output: 60.00 },
};

// Estimate cost from token count. Assumes ~40% input / 60% output split.
export function estimateCost(totalTokens: number, model: string): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing || totalTokens === 0) return 0;
  const inputTokens = totalTokens * 0.4;
  const outputTokens = totalTokens * 0.6;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// Estimate cost across multiple models (for multi-agent runs)
export function estimateMultiModelCost(
  totalTokens: number,
  models: string[]
): number {
  if (models.length === 0 || totalTokens === 0) return 0;
  const tokensPerModel = totalTokens / models.length;
  return models.reduce((sum, m) => sum + estimateCost(tokensPerModel, m), 0);
}

// ─── Agent Config ─────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  provider: ModelProvider;
  model: string;
  apiKey: string; // empty string = use server-side key
  context: string; // this agent's private context
}

// ─── Negotiation Config ───────────────────────────────────

export interface NegotiationConfig {
  question: string;
  sharedContext: string;
  hostPrivateContext: string;
  agents: AgentConfig[];
  tokenBudget: number; // max tokens across entire negotiation
  maxRounds: number; // default 2
}

// ─── Legacy types (kept for DB compat with old results) ──

export type DisagreementType =
  | "miscommunication"
  | "differing-assumptions"
  | "different-objectives";

export interface Disagreement {
  topic: string;
  type: DisagreementType;
  parties: string[];
  summary: string;
  suggestedResolution?: string;
}

export interface DecisionPoint {
  topic: string;
  type: DisagreementType;
  options: Array<{
    label: string;
    advocatedBy: string[];
    tradeoff: string;
  }>;
  recommendation?: string;
}

// ─── Competing Proposals Model ───────────────────────────

export interface ProposalSummary {
  agentId: string;
  headline: string;
  keyPoints: string[];
  strengths: string[];
  risks: string[];
}

export interface KeyDifference {
  dimension: string;
  proposals: Record<string, string>; // agentId → position on this dimension
}

// ─── Administrator Synthesis ──────────────────────────────

export interface Synthesis {
  proposals: ProposalSummary[];
  commonGround: string[];
  keyDifferences: KeyDifference[];
  recommendation: {
    agentId: string;
    reasoning: string;
  };
  blendOpportunity?: string;
  summary: string;
}

// ─── Transcript / Events ──────────────────────────────────

export type PhaseType =
  | "research"
  | "synthesis"
  | "decision"
  | "resolution"
  | "final-responses"
  | "complete";

export interface ResearchResult {
  agentId: string;
  agentName: string;
  provider: ModelProvider;
  model: string;
  content: string;
  tokensUsed: number;
}

// ─── Final Response (after host decides) ─────────────────

export interface FinalResponse {
  agentId: string;
  agentName: string;
  provider: ModelProvider;
  model: string;
  content: string; // short acknowledgement + final thoughts
}

export interface NegotiationState {
  phase: PhaseType;
  round: number;
  research: ResearchResult[];
  syntheses: Synthesis[];
  humanDecisions: string[];
  hostClarifications: string[];
  totalTokensUsed: number;
  transcript: string;
}
