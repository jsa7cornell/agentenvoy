// ─── Provider / Model ─────────────────────────────────────

export type ModelProvider = "anthropic" | "google" | "openai";

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
};

export const DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-flash",
  openai: "gpt-4o",
};

export const MODEL_OPTIONS: Record<ModelProvider, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-haiku-4-5"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash"],
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
};

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

// ─── Disagreement Taxonomy ────────────────────────────────

export type DisagreementType =
  | "miscommunication"
  | "differing-assumptions"
  | "different-objectives";

export interface Disagreement {
  topic: string;
  type: DisagreementType;
  parties: string[]; // agent IDs
  summary: string;
  suggestedResolution?: string;
}

export interface DecisionPoint {
  topic: string;
  type: DisagreementType;
  options: Array<{
    label: string;
    advocatedBy: string[]; // agent IDs
    tradeoff: string;
  }>;
  recommendation?: string;
}

// ─── Administrator Synthesis ──────────────────────────────

export interface Synthesis {
  agreements: string[];
  disagreements: Disagreement[];
  decisionPoints: DecisionPoint[];
  summary: string;
  isResolved: boolean;
  recommendMoreRounds?: boolean;
  hostClarificationNeeded?: string;
}

// ─── Transcript / Events ──────────────────────────────────

export type PhaseType =
  | "research"
  | "synthesis"
  | "decision"
  | "resolution"
  | "complete";

export interface ResearchResult {
  agentId: string;
  agentName: string;
  provider: ModelProvider;
  model: string;
  content: string;
  tokensUsed: number;
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
