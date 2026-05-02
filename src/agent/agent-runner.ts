import { streamText, generateText, stepCountIs, type StepResult, type ToolSet } from "ai";
import { envoyModel } from "@/lib/model";
import { composeSystemPrompt, getModelForDomain } from "./composer";
import type { DomainType } from "./composer";
import type { CalendarContext } from "@/lib/calendar";
import type { ScoredSlot } from "@/lib/scoring";
import type { ToolRegistry } from "./tools/registry";

/**
 * Persisted record of a tool invocation that fired during a single
 * `streamAgentResponse` call. Lands on `Message.metadata.toolInvocations[]`
 * so feedback bundles can replay what the model did mid-turn.
 *
 * Shape is provider-agnostic (no Anthropic-specific block types) so we can
 * swap providers without rewriting the persistence layer.
 */
export interface ToolInvocationRecord {
  name: string;
  /** JSON-serializable input the model produced. */
  input: unknown;
  /** JSON-serializable output the tool's `execute` returned. */
  output?: unknown;
  /** Whether the tool errored during execution. */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
}

export type AgentRole = "coordinator" | "administrator";

export interface AgentContext {
  role: AgentRole;
  sessionId?: string;
  hostName: string;
  hostPreferences?: Record<string, unknown>;
  guestName?: string;
  guestEmail?: string;
  guestTimezone?: string; // IANA timezone from browser, e.g., "America/New_York"
  /** Viewer-authoritative tz on NegotiationSession. Set → dual-tz mode for
   *  this session (decision #8, 2026-04-21 guest-tz-ux-three-primitives). */
  viewerTimezone?: string | null;
  /** Current guest message text (for deterministic time-reference parsing —
   *  decision #9). Only consulted in dual-tz mode. */
  guestMessage?: string;
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
  /** Guest-negotiated activity/location/format already locked this session. */
  negotiatedActivity?: string | null;
  negotiatedLocation?: string | null;
  negotiatedFormat?: string | null;
  /** Host-offered activity menu (activityOptions from link.parameters). */
  activityOptions?: string[] | null;
  /**
   * PR3 of the 2026-04-27 chat-decisioning-layer-redesign. When `true`,
   * the speaker for this turn is the deal-room HOST (not the guest), and
   * the composer loads `dealroom-host-composer.md`. False / undefined →
   * guest path. Threaded from `/api/negotiate/message` where it's derived
   * from auth (session.user.id === negotiationSession.hostId).
   */
  isHost?: boolean;
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
    viewerTimezone: context.viewerTimezone,
    guestMessage: context.guestMessage,
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
    negotiatedActivity: context.negotiatedActivity,
    negotiatedLocation: context.negotiatedLocation,
    negotiatedFormat: context.negotiatedFormat,
    activityOptions: context.activityOptions,
    isHost: context.isHost,
  };
}

/**
 * Maximum number of model steps per `streamAgentResponse` call when tools
 * are registered. One "step" = one model turn (text or tool-call). With
 * tools enabled, a turn might be: tool_use → tool_result → final text =
 * 2 steps. We cap at 5 to allow up to two tool round-trips with a final
 * text turn, and as a defense against runaway loops. Bumped here = bumped
 * for every consumer; revisit per-tool if a use case needs more.
 *
 * Background: 2026-04-29 bilateral+picker bundle, PR-0a.
 */
const MAX_TOOL_STEPS = 5;

/**
 * Final-state info passed to `onFinish` after streaming completes.
 *
 * `text` is the FINAL assistant text turn — the same shape callers had
 * before tools were introduced, so existing parsers (`[ACTION]`,
 * `[CONFIRMATION_PROPOSAL]`, `[STATUS_UPDATE]`) at
 * `negotiate/message/route.ts:283–294` continue to operate on the right
 * surface without modification. Tool-call and tool-result turns are NOT
 * concatenated into `text` — they live on `toolInvocations`.
 *
 * `toolInvocations` is empty when no tools were registered or none fired.
 */
export interface StreamAgentFinishResult {
  text: string;
  toolInvocations: ToolInvocationRecord[];
}

export async function streamAgentResponse(
  context: AgentContext,
  options?: {
    /**
     * Tools the model may call during this turn. Pass `undefined` (or omit)
     * for the no-tools path — agent runner falls back to single-turn
     * streaming with no step cap. Per the registry's privacy/scope
     * discipline (`src/agent/tools/registry.ts`), each call site explicitly
     * opts into the tool surface; there is no ambient registry.
     */
    tools?: ToolRegistry;

    onFinish?: (result: StreamAgentFinishResult) => void | Promise<void>;

    /** Called once with the composed system prompt + modelId, right before
     *  streamText kicks off. Callers use this to snapshot the prompt onto
     *  Message.metadata.promptContext for post-hoc debug (feedback pipeline). */
    onInvocation?: (info: { systemPrompt: string; modelId: string }) => void;
  }
) {
  const opts = buildComposeOptions(context);
  const systemPrompt = composeSystemPrompt(opts);
  const modelId = getModelForDomain(opts.domain);
  options?.onInvocation?.({ systemPrompt, modelId });

  const tools = options?.tools;
  const hasTools = tools !== undefined && Object.keys(tools).length > 0;

  // Track per-step durations so we can populate `toolInvocations[].durationMs`
  // honestly. AI SDK's `onStepFinish` exposes step-level timing indirectly;
  // we compute by stamping start/end times around the step boundaries.
  const stepStartTimes: number[] = [];

  return streamText({
    model: envoyModel(modelId),
    maxOutputTokens: 2048,
    system: systemPrompt,
    messages: context.conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    // Only thread tools when present — keeps the no-tools path identical
    // to the pre-PR-0a call shape (no `tools`, no step budget) so any
    // behavior change is gated on opt-in.
    ...(hasTools
      ? {
          tools,
          stopWhen: stepCountIs(MAX_TOOL_STEPS),
        }
      : {}),
    onStepFinish: hasTools
      ? () => {
          stepStartTimes.push(Date.now());
        }
      : undefined,
    onFinish: options?.onFinish
      ? async (result) => {
          const text = result.text ?? "";
          const toolInvocations = hasTools
            ? extractToolInvocations(result.steps as ReadonlyArray<StepResult<ToolSet>>)
            : [];
          await options.onFinish?.({ text, toolInvocations });
        }
      : undefined,
  });
}

/**
 * Walk each step's tool calls + matched results into a flat list of
 * persistable invocation records. The AI SDK groups calls and results
 * across step boundaries (a tool_use in step N produces a tool_result
 * available in step N+1). We pair them by `toolCallId`.
 *
 * Errors during execute are captured as `error: string` rather than
 * thrown — the model already saw the error in its tool_result, and
 * killing the turn would lose the rest of the response.
 */
function extractToolInvocations(
  steps: ReadonlyArray<StepResult<ToolSet>>,
): ToolInvocationRecord[] {
  const records: ToolInvocationRecord[] = [];
  // Map call-id → record so we can attach results (which arrive in a later
  // step) onto the right invocation.
  const byId = new Map<string, ToolInvocationRecord>();

  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      const record: ToolInvocationRecord = {
        name: call.toolName,
        input: call.input,
      };
      byId.set(call.toolCallId, record);
      records.push(record);
    }
    for (const result of step.toolResults ?? []) {
      const record = byId.get(result.toolCallId);
      if (!record) continue;
      // AI SDK exposes tool errors via the result's typed shape — when an
      // execute throws, `result.output` is replaced with an error result
      // that surfaces via the `dynamic` flag or `result.error`. Defensive:
      // try to capture both shapes.
      const r = result as unknown as {
        output?: unknown;
        error?: { message?: string } | string;
      };
      if (r.error) {
        record.error =
          typeof r.error === "string" ? r.error : r.error.message ?? "tool execution failed";
      } else {
        record.output = r.output;
      }
    }
  }

  return records;
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

- availability: object with three optional sub-fields (the per-link event-availability layer):
  - expand: array of { days?: ["Mon",...], window?: {start:"HH:MM", end:"HH:MM"} } — ADDITIVELY extends what's offerable beyond normal calendar availability. Use for "open up early mornings", "add Saturday", "include weekends", "also offer 7am". Each entry needs at least one of days or window.
  - restrictToDays: array of short day names — ONLY these days are offerable. Use for "only Wednesdays", "Mondays only", "just weekdays".
  - restrictToWindows: array of {start, end} — ONLY these per-day windows are offerable. Use for "only afternoons", "limit to 5-8pm", "just before noon".
- preferred: object with three optional sub-fields (decoration only — never hides slots, just marks the host's favored subset for the greeting and ★ display):
  - days: array of short day names — host prefers these days but other days are still bookable. Use for "prefer Wednesdays", "ideally Mondays", "Wed is best".
  - windows: array of {start, end} — host prefers these times. Use for "prefer afternoons", "ideally before noon", "afternoons are best".
- dateRange: { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } — inclusive host-local window. Omit if open-ended.
- format: "phone" | "video" | "in-person" | "any". Aliases: "vc","video conference","videoconference","zoom","meet" → "video"; bare "call" → "phone"; "coffee","lunch","drinks" → "in-person".
- duration: number in minutes (default 30)
- isVip: boolean — see VIP RULES below. Omit entirely if not VIP.
- inviteeEmail: string or null
- inviteeName: string or null
- inviteeTimezone: IANA timezone string when the host declares where the invitee is (e.g. "Sarah is on EST" → "America/New_York", "she's in Tokyo" → "Asia/Tokyo"). Omit if not explicitly stated.
- topic: string or null
- notes: string or null
- steering: "open" | "soft" | "narrow" | "exclusive" — host-intent classification (greeting tone only; does NOT affect slot scoring). Apply the 4-step discriminator ladder:
  1. Did the user name ANY preference? If no → "open" (e.g. "get time with X", "anytime next two weeks").
  2. Did they signal fallback (else/preferred/ideally/but/or)? If yes → "soft" (e.g. "Wed ideally else Thu").
  3. Did they name specific slots, not a window (2+ enumerated offerings)? If yes → "exclusive" (e.g. "3pm Tuesday or 4pm Wednesday").
  4. Otherwise → "narrow" (e.g. "Tuesday afternoon only", "Mon-Wed next week").
  Cost asymmetry — WHEN IN DOUBT, PICK OPEN.

DISAMBIGUATION RULES — restrict vs. expand vs. prefer:
- ADDITIVE language ("open up", "also", "add", "include", "throw in") → availability.expand
- RESTRICTIVE language ("only", "just", "limit to", "Mondays only") → availability.restrictTo*
- PREFERENCE language ("prefer", "ideally", "best", "favorite", "would love") → preferred.*
- BARE AMBIGUOUS phrases ("afternoons", "Wednesdays") with no qualifier word — on FIRST-TURN link creation, ASK the host: "Do you want to restrict this link to {X} only, or just prefer {X} (other times still bookable)?". Do NOT emit immediately.
- BARE AMBIGUOUS phrases on FOLLOW-UP turns — emit as preferred.* (default-soft); the host can correct in the next turn if they meant restrict.

VIP RULES (critical — isVip is a single binary flag, not a tier ladder):
- Default is NOT VIP. Emit isVip only when the host gives a clear signal.
- Set isVip: true when the host says: "VIP", "important client", "high priority", "make room for X", "clear my calendar", "CEO", "board member", "investor", "biggest deal", or equivalent.
- International context ALONE ("she's in Europe", "he's in Tokyo") is ALSO a VIP signal — set isVip: true.
- Never emit priority, high, low, vip as strings — isVip is always a boolean.
- VIP does NOT automatically unlock any protected slots on its own. It signals Envoy that she may proactively ask about expansion. The host still decides actual expansion via availability.expand in a follow-up turn.

IMPORTANT — separate the TWO kinds of signals:
- "VIP" / urgency / international context → isVip: true
- Concrete clock time the host said with additive intent ("6 AM works", "open up early mornings") → availability.expand
- Concrete clock time with restrictive intent ("only mornings", "limit to 9-12") → availability.restrictToWindows
- A vague "open it up" without a clock time → isVip: true ONLY. Do NOT guess a window.

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
