import { streamText, generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { composeSystemPrompt, getModelForDomain } from "./composer";
import type { DomainType } from "./composer";
import type { CalendarContext } from "@/lib/calendar";
import type { ScoredSlot } from "@/lib/scoring";

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
  /** Pre-scored slots — when provided, prompt shows offerable blocks instead of raw events */
  scoredSlots?: ScoredSlot[];
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
    scoredSlots: context.scoredSlots,
    hostPersistentKnowledge: context.hostPersistentKnowledge,
    hostUpcomingSchedulePreferences: context.hostUpcomingSchedulePreferences,
    hostDirectives: context.hostDirectives,
    isGroupEvent: context.isGroupEvent,
    eventParticipants: context.eventParticipants,
    role: context.role,
  };
}

export async function streamAgentResponse(
  context: AgentContext,
  options?: { onFinish?: (result: { text: string }) => void | Promise<void> }
) {
  const opts = buildComposeOptions(context);
  const systemPrompt = composeSystemPrompt(opts);

  return streamText({
    model: envoyModel(getModelForDomain(opts.domain)),
    maxOutputTokens: 2048,
    system: systemPrompt,
    messages: context.conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    onFinish: options?.onFinish,
  });
}

export async function generateAgentResponse(context: AgentContext) {
  const opts = buildComposeOptions(context);
  const systemPrompt = composeSystemPrompt(opts);

  const { text } = await generateText({
    model: envoyModel(getModelForDomain(opts.domain)),
    maxOutputTokens: 2048,
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
    maxOutputTokens: 512,
    system: `You parse natural language scheduling preferences into structured JSON for a meeting negotiation link. Extract ONLY these fields (never invent new ones — the downstream engine ignores unknown keys):

- preferredDays: array of short day names (["Mon","Tue","Wed","Thu","Fri"]) or omit for "any"
- preferredTimeStart: "HH:MM" 24-hour, earliest time in each day to offer (e.g. "09:00"). Omit unless the host names a concrete clock time.
- preferredTimeEnd: "HH:MM" 24-hour, latest time in each day to offer. Omit unless the host names a concrete clock time.
- dateRange: { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } — inclusive host-local window. Omit if open-ended.
- format: "phone" | "video" | "in-person" | "any". Aliases: "vc","video conference","videoconference","zoom","meet" → "video"; bare "call" → "phone"; "coffee","lunch","drinks" → "in-person".
- duration: number in minutes (default 30)
- isVip: boolean — see VIP RULES below. Omit entirely if not VIP.
- inviteeEmail: string or null
- inviteeName: string or null
- inviteeTimezone: IANA timezone string when the host declares where the invitee is (e.g. "Sarah is on EST" → "America/New_York", "she's in Tokyo" → "Asia/Tokyo"). Omit if not explicitly stated. This is a seed for the deal-room greeting — wrong values produce wrong times, so only emit when the host names a concrete location or zone.
- topic: string or null
- notes: string or null

VIP RULES (critical — isVip is a single binary flag, not a tier ladder):
- Default is NOT VIP. Emit isVip only when the host gives a clear signal.
- Set isVip: true when the host says: "VIP", "important client", "high priority", "priority meeting", "make room for X", "clear my calendar", "drop everything", "CEO", "board member", "key account", "investor", "biggest deal", "most important meeting", or any equivalent.
- International context ALONE ("she's in Europe", "he's in Tokyo") is ALSO a VIP signal — set isVip: true so Envoy will proactively ask the host about opening up stretch hours during the deal room conversation.
- Never emit priority, high, low, vip as strings — isVip is always a boolean.
- VIP does NOT automatically unlock any protected slots on its own. It signals Envoy that she may proactively ask the host about expansion, may reach into stretch options on guest pushback, and may propose tentative holds for specific stretch slots. The host still decides the actual expansion via preferredTimeStart/End or allowWeekends in a follow-up turn.

IMPORTANT — separate the TWO kinds of signals:
- "VIP" / urgency / international context → isVip: true
- Concrete clock time the host said ("6 AM works", "offer until 9 PM") → preferredTimeStart / preferredTimeEnd
- A vague "open it up" without a clock time → isVip: true ONLY. Do NOT guess a preferredTimeStart.

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
    maxOutputTokens: 512,
    system: `You analyze completed scheduling negotiation transcripts to extract learnings about the host (${hostName}).

You maintain two knowledge layers:
1. **Persistent Preferences** — durable patterns, preferences, identity. Rarely changes. Examples: "prefers mornings for calls", "needs 30 min travel buffer for in-person", "likes to stack meetings on MWF".
2. **Situational Context** — near-term overrides, upcoming events, temporary rules. Changes frequently, can expire. Examples: "in Mexico next week", "training for a race this month".

CRITICAL — DO NOT record specific booked meetings (e.g. "Meeting booked: Thu at 8 AM with Alex"). The user's calendar is the single source of truth for booked meetings; the system already injects live calendar events into every prompt via a separate "computed schedule" section. Writing booked-meeting lines here duplicates the calendar into a free-text field that goes stale the moment a meeting is cancelled or rescheduled, poisoning future prompts. Record patterns ("books most calls in the morning") and declared context ("traveling next week"), never specific events.

You receive the existing content of both layers plus a negotiation transcript. Your job:
- Extract any new observations from the transcript
- Merge them into the appropriate layer (persistent vs situational)
- Remove expired situational items
- Remove any stale "Meeting booked:" / "now booked" / "just confirmed" lines from the existing situational text (they should never have been there)
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
      persistent: stripBookedMeetingLines(parsed.persistent || existingPersistent || ""),
      situational: stripBookedMeetingLines(parsed.situational || existingSituational || ""),
    };
  } catch {
    return {
      persistent: stripBookedMeetingLines(existingPersistent || ""),
      situational: stripBookedMeetingLines(existingSituational || ""),
    };
  }
}

/**
 * Belt-and-suspenders filter: drop any line that records a specific booked
 * meeting. The user's calendar is the single source of truth — duplicating
 * events into free-text goes stale on cancel/reschedule and poisons future
 * prompts. Prompt-level guidance in extractLearnings forbids this, but the
 * LLM occasionally regresses; this regex catches the regression.
 */
function stripBookedMeetingLines(text: string): string {
  if (!text) return text;
  const DROP = /(meeting booked|now booked|just confirmed|just booked)/i;
  return text
    .split(/\r?\n/)
    .filter((line) => !DROP.test(line))
    .join("\n")
    .trim();
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
      maxOutputTokens: 512,
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
