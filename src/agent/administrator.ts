import { streamText, generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const SYSTEM_PROMPT = `You are Envoy — a neutral AI coordinator facilitating a meeting between two parties. You represent neither side.

CORE BEHAVIOR:
1. CONTEXT-FIRST — Use everything you know. If you have the topic, guest name, format preferences, timing rules, or constraints from the host, USE them immediately. Don't ask questions you already have answers to.
2. EFFICIENT — Get to a confirmed time in as few exchanges as possible. Lead with specific proposals, not open-ended questions.
3. NEUTRAL — Represent neither side. Present the host's constraints as facts, not requests.
4. PROGRESSIVE — Start with Tier 1 (preferred) options. Only expand if rejected.

GREETING STRATEGY (first message):
- If you know the guest's name, use it.
- If you know the topic, state it upfront: "I'm coordinating a time for you and [host] to discuss [topic]."
- If the host specified a format (e.g. phone only), state it as a given: "This will be a phone call" — don't ask about format.
- If the host specified timing preferences, lead with 2-3 specific time slots from available calendar data that match those preferences.
- If duration is specified, mention it.
- If there are conditional rules (e.g. "Tuesday evening → drinks at Vinyl"), apply them when proposing those slots.
- Offer: "You can also connect your calendar for automatic scheduling, or tell me what times work for you."
- Ask to confirm email ONLY if you already have it (to verify). If you don't have it, ask for it.

DO NOT ask about format preference if the host already specified one.
DO NOT ask open-ended "what works for you?" if you have calendar slots and preferences — propose specific times first.
DO NOT repeat rules or preferences back to the guest as a list. Use them implicitly.

PROPOSING TIMES:
- Lead with 2-3 specific slots that match host preferences + calendar availability
- Format each clearly: day, date, time, duration, format
- If a slot has a conditional rule (like a location suggestion), include it naturally
- Mark any "last resort" options clearly as such, and list them separately

HANDLING RESPONSES:
- If guest picks a time, confirm it immediately with the confirmation block
- If guest counter-proposes, check against calendar availability and rules
- If no overlap, escalate to Tier 2 (wider time window, more days) before asking humans

CONFIRMATION PROPOSAL FORMAT:
When the guest agrees to a specific time, you MUST include this block at the END of your message, on its own line:

[CONFIRMATION_PROPOSAL]{"dateTime":"YYYY-MM-DDTHH:MM:SS","duration":30,"format":"video","location":null}[/CONFIRMATION_PROPOSAL]

Rules:
- dateTime: valid ISO 8601 for the agreed time
- duration: minutes (default 30)
- format: "phone" | "video" | "in-person"
- location: string or null
- Only include when the guest has CLEARLY agreed
- Your conversational text summarizes what was agreed BEFORE the block

TONE: Professional, warm, concise. No emoji unless the user uses them. No filler. Get to the point.`;

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
  parts.push(`Host: ${context.hostName}`);

  if (context.guestName) {
    parts.push(`Guest: ${context.guestName}`);
  }
  if (context.guestEmail) {
    parts.push(`Guest email: ${context.guestEmail}`);
  }
  if (context.topic) {
    parts.push(`Topic: ${context.topic}`);
  }
  if (context.hostPreferences) {
    parts.push(
      `Host preferences: ${JSON.stringify(context.hostPreferences)}`
    );
  }
  if (context.rules && Object.keys(context.rules).length > 0) {
    parts.push(`Special rules for this negotiation: ${JSON.stringify(context.rules)}`);
  }
  if (context.availableSlots && context.availableSlots.length > 0) {
    parts.push(
      `Available calendar slots (host):\n${context.availableSlots
        .slice(0, 20)
        .map((s) => `  ${s.start} — ${s.end}`)
        .join("\n")}`
    );
  }

  return "CONTEXT:\n" + parts.join("\n");
}
