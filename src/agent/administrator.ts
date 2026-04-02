import { streamText, generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { composeSystemPrompt, getModelForDomain } from "./composer";
import type { DomainType } from "./composer";

export type AgentRole = "coordinator" | "administrator";

export interface AgentContext {
  role: AgentRole;
  hostName: string;
  hostPreferences?: Record<string, unknown>;
  guestName?: string;
  guestEmail?: string;
  topic?: string;
  rules?: Record<string, unknown>;
  availableSlots?: Array<{ start: string; end: string }>;
  conversationHistory: Array<{ role: string; content: string }>;
}

function getDomain(context: AgentContext): DomainType {
  return context.role === "coordinator" ? "calendar" : "calendar"; // RFP comes later
}

export async function streamAgentResponse(context: AgentContext) {
  const domain = getDomain(context);
  const systemPrompt = composeSystemPrompt({
    domain,
    hostName: context.hostName,
    hostPreferences: context.hostPreferences,
    guestName: context.guestName,
    guestEmail: context.guestEmail,
    topic: context.topic,
    rules: context.rules,
    availableSlots: context.availableSlots,
    role: context.role,
  });

  return streamText({
    model: anthropic(getModelForDomain(domain)),
    system: systemPrompt,
    messages: context.conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });
}

export async function generateAgentResponse(context: AgentContext) {
  const domain = getDomain(context);
  const systemPrompt = composeSystemPrompt({
    domain,
    hostName: context.hostName,
    hostPreferences: context.hostPreferences,
    guestName: context.guestName,
    guestEmail: context.guestEmail,
    topic: context.topic,
    rules: context.rules,
    availableSlots: context.availableSlots,
    role: context.role,
  });

  const { text } = await generateText({
    model: anthropic(getModelForDomain(domain)),
    system: systemPrompt,
    messages: context.conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });

  return text;
}

export async function parsePreferences(
  userPrompt: string
): Promise<Record<string, unknown>> {
  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    system: `You parse natural language scheduling preferences into structured JSON. Extract:
- preferredDays: array of day names or "any"
- preferredTimes: array of time ranges like "morning", "afternoon", "9am-12pm"
- format: "phone" | "video" | "in-person" | "any"
- duration: number in minutes (default 30)
- location: string or null
- constraints: array of strings (things to avoid)
- priority: "high" | "normal" | "low"
- inviteeEmail: string or null
- inviteeName: string or null
- topic: string or null
- notes: string or null

Return ONLY valid JSON, no markdown or explanation.`,
    prompt: userPrompt,
  });

  try {
    return JSON.parse(text);
  } catch {
    return { raw: userPrompt, parseError: true };
  }
}
