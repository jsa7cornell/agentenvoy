import { streamText, generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { composeSystemPrompt, getModelForDomain } from "./composer";
import type { DomainType } from "./composer";
import type { CalendarContext } from "@/lib/calendar";

export type AgentRole = "coordinator" | "administrator";

export interface AgentContext {
  role: AgentRole;
  sessionId?: string;
  hostName: string;
  hostPreferences?: Record<string, unknown>;
  guestName?: string;
  guestEmail?: string;
  guestTimezone?: string; // IANA timezone from browser, e.g., "America/New_York"
  topic?: string;
  rules?: Record<string, unknown>;
  /** @deprecated Use calendarContext instead */
  availableSlots?: Array<{ start: string; end: string }>;
  calendarContext?: CalendarContext;
  hostPersistentKnowledge?: string | null;
  hostUpcomingSchedulePreferences?: string | null;
  hostDirectives?: string[];
  isGroupEvent?: boolean;
  eventParticipants?: Array<{
    name: string;
    status: string;
    statedAvailability?: string;
  }>;
  conversationHistory: Array<{ role: string; content: string }>;
}

function getDomain(context: AgentContext): DomainType {
  return context.role === "coordinator" ? "calendar" : "calendar"; // RFP comes later
}

function buildComposeOptions(context: AgentContext) {
  const domain = getDomain(context);
  return {
    domain,
    sessionId: context.sessionId,
    hostName: context.hostName,
    hostPreferences: context.hostPreferences,
    guestName: context.guestName,
    guestEmail: context.guestEmail,
    guestTimezone: context.guestTimezone,
    topic: context.topic,
    rules: context.rules,
    availableSlots: context.availableSlots,
    calendarContext: context.calendarContext,
    hostPersistentKnowledge: context.hostPersistentKnowledge,
    hostUpcomingSchedulePreferences: context.hostUpcomingSchedulePreferences,
    hostDirectives: context.hostDirectives,
    isGroupEvent: context.isGroupEvent,
    eventParticipants: context.eventParticipants,
    role: context.role,
  };
}

export async function streamAgentResponse(context: AgentContext) {
  const opts = buildComposeOptions(context);
  const systemPrompt = composeSystemPrompt(opts);

  return streamText({
    model: envoyModel(getModelForDomain(opts.domain)),
    system: systemPrompt,
    messages: context.conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });
}

export async function generateAgentResponse(context: AgentContext) {
  const opts = buildComposeOptions(context);
  const systemPrompt = composeSystemPrompt(opts);

  const { text } = await generateText({
    model: envoyModel(getModelForDomain(opts.domain)),
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
    model: envoyModel("claude-sonnet-4-6"),
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

/**
 * Extract learnings from a completed negotiation transcript.
 * Uses Claude to merge new observations into the appropriate knowledge layer.
 * Persistent: durable patterns/preferences. Situational: near-term context.
 */
export async function extractLearnings(
  transcript: string,
  existingPersistent: string | null,
  existingSituational: string | null,
  hostName: string
): Promise<{ persistent: string; situational: string }> {
  const { text } = await generateText({
    model: envoyModel("claude-sonnet-4-6"),
    system: `You analyze completed scheduling negotiation transcripts to extract learnings about the host (${hostName}).

You maintain two knowledge layers:
1. **Persistent Preferences** — durable patterns, preferences, identity. Rarely changes. Examples: "prefers mornings for calls", "needs 30 min travel buffer for in-person", "likes to stack meetings on MWF".
2. **Situational Context** — near-term overrides, upcoming events, temporary rules. Changes frequently, can expire. Examples: "in Mexico next week", "training for a race this month".

You receive the existing content of both layers plus a negotiation transcript. Your job:
- Extract any new observations from the transcript
- Merge them into the appropriate layer (persistent vs situational)
- Remove expired situational items
- Deduplicate — don't repeat what's already there
- Keep each layer under 500 words
- Return as JSON: {"persistent": "...", "situational": "..."}

If nothing new was learned, return the existing content unchanged.
Return ONLY valid JSON, no markdown or explanation.`,
    prompt: `Existing persistent knowledge:\n${existingPersistent || "(empty)"}\n\nExisting situational knowledge:\n${existingSituational || "(empty)"}\n\nNegotiation transcript:\n${transcript}`,
  });

  try {
    const parsed = JSON.parse(text);
    return {
      persistent: parsed.persistent || existingPersistent || "",
      situational: parsed.situational || existingSituational || "",
    };
  } catch {
    return {
      persistent: existingPersistent || "",
      situational: existingSituational || "",
    };
  }
}

/**
 * Extract a short availability summary from a participant's conversation.
 * Used to build cross-session context in group events.
 */
export async function extractAvailabilitySummary(
  messages: Array<{ role: string; content: string }>
): Promise<string | null> {
  // Only process if there are guest messages with substance
  const guestMessages = messages.filter((m) => m.role === "guest" || m.role === "user");
  if (guestMessages.length === 0) return null;

  const transcript = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  try {
    const { text } = await generateText({
      model: envoyModel("claude-haiku-4-5-20251001"),
      system: `Extract a 1-2 sentence availability summary from this scheduling conversation. Focus on: what days/times work, what doesn't work, format preferences. If no availability has been stated yet, return "NO_AVAILABILITY". Return ONLY the summary text, no explanation.`,
      prompt: transcript,
    });

    const trimmed = text.trim();
    if (trimmed === "NO_AVAILABILITY" || trimmed.length < 5) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Build a human-readable preview of what the agent knows about a host.
 * Used for the "show me my prompt" feature.
 */
export function buildKnowledgePreview(params: {
  preferences?: Record<string, unknown>;
  directives?: string[];
  persistentKnowledge?: string | null;
  upcomingSchedulePreferences?: string | null;
}): string {
  const parts: string[] = [];

  // Preferences
  if (params.preferences && Object.keys(params.preferences).length > 0) {
    parts.push("## Preferences");
    const explicit = params.preferences.explicit as Record<string, unknown> | undefined;
    if (explicit) {
      for (const [key, value] of Object.entries(explicit)) {
        if (value !== null && value !== undefined && value !== "") {
          parts.push(`- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
        }
      }
    } else {
      for (const [key, value] of Object.entries(params.preferences)) {
        if (key !== "learned" && value !== null && value !== undefined && value !== "") {
          parts.push(`- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
        }
      }
    }
  }

  // Directives
  if (params.directives && params.directives.length > 0) {
    parts.push("\n## Directives");
    for (const d of params.directives) {
      parts.push(`- ${d}`);
    }
  }

  // Persistent Knowledge
  if (params.persistentKnowledge) {
    parts.push("\n## Persistent Preferences");
    parts.push(params.persistentKnowledge);
  }

  // Situational Knowledge
  if (params.upcomingSchedulePreferences) {
    parts.push("\n## Situational Context");
    parts.push(params.upcomingSchedulePreferences);
  }

  return parts.length > 0 ? parts.join("\n") : "No preferences or knowledge configured yet.";
}
