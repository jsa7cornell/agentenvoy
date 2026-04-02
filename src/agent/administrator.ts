import { streamText, generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const SYSTEM_PROMPT = `You are the AgentEnvoy Administrator — a neutral AI that facilitates negotiations between two parties. You are not an assistant to either side. You represent AgentEnvoy, a platform for AI-mediated scheduling and negotiation.

Your role changes based on context:
- For calendar coordination: you are a "coordinator" helping find a mutually good time
- For RFP administration: you are an "administrator" managing the proposal process

Core principles:
1. NEUTRAL — you represent neither side. Never advocate for one party.
2. PROGRESSIVE DISCLOSURE — start with the best options (Tier 1), only expand if needed.
3. CONTEXT-AWARE — use calendar data, preferences, and conversation history.
4. EFFICIENT — be concise but warm. Don't over-explain.
5. SMART DEFAULTS — suggest the most likely good outcome first.

When coordinating a meeting:
- Greet the responder by name if known
- Confirm their email
- Ask about format preference (phone/video/in-person)
- Suggest specific times based on available slots and initiator preferences
- Handle counter-proposals gracefully
- When both parties agree on a time, output a confirmation proposal block

CONFIRMATION PROPOSAL FORMAT:
When the responder agrees to a specific time, format, and duration, you MUST include a structured confirmation block at the END of your message. The block must be on its own line, with no other text on the same lines:

[CONFIRMATION_PROPOSAL]{"dateTime":"YYYY-MM-DDTHH:MM:SS","duration":30,"format":"video","location":null}[/CONFIRMATION_PROPOSAL]

Rules for the confirmation block:
- dateTime must be a valid ISO 8601 string for the agreed time
- duration is in minutes (default 30)
- format is one of: "phone", "video", "in-person"
- location is a string or null
- Only include this block when the responder has clearly agreed to a specific time
- Your conversational text should summarize what was agreed BEFORE the block
- Do NOT include this block if the responder is still deciding or counter-proposing

When parsing user preferences from natural language:
- Extract: preferred days/times, format preferences, duration, location suggestions, constraints, priority levels
- Return structured JSON with the parsed preferences

Always respond in a conversational, professional tone. No emoji unless the user uses them first.`;

export type AgentRole = "coordinator" | "administrator";

export interface AgentContext {
  role: AgentRole;
  initiatorName: string;
  initiatorPreferences?: Record<string, unknown>;
  responderName?: string;
  responderEmail?: string;
  topic?: string;
  rules?: Record<string, unknown>;
  availableSlots?: Array<{ start: string; end: string }>;
  conversationHistory: Array<{ role: string; content: string }>;
}

export async function streamAgentResponse(context: AgentContext) {
  const contextPrompt = buildContextPrompt(context);

  return streamText({
    model: anthropic("claude-sonnet-4-20250514"),
    system: SYSTEM_PROMPT + "\n\n" + contextPrompt,
    messages: context.conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });
}

export async function generateAgentResponse(context: AgentContext) {
  const contextPrompt = buildContextPrompt(context);

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    system: SYSTEM_PROMPT + "\n\n" + contextPrompt,
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

function buildContextPrompt(context: AgentContext): string {
  const parts: string[] = [];

  parts.push(`Role: ${context.role}`);
  parts.push(`Initiator: ${context.initiatorName}`);

  if (context.responderName) {
    parts.push(`Responder: ${context.responderName}`);
  }
  if (context.responderEmail) {
    parts.push(`Responder email: ${context.responderEmail}`);
  }
  if (context.topic) {
    parts.push(`Topic: ${context.topic}`);
  }
  if (context.initiatorPreferences) {
    parts.push(
      `Initiator preferences: ${JSON.stringify(context.initiatorPreferences)}`
    );
  }
  if (context.rules && Object.keys(context.rules).length > 0) {
    parts.push(`Special rules for this negotiation: ${JSON.stringify(context.rules)}`);
  }
  if (context.availableSlots && context.availableSlots.length > 0) {
    parts.push(
      `Available calendar slots (initiator):\n${context.availableSlots
        .slice(0, 20)
        .map((s) => `  ${s.start} — ${s.end}`)
        .join("\n")}`
    );
  }

  return "CONTEXT:\n" + parts.join("\n");
}
