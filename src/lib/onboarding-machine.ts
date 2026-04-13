/**
 * Onboarding state machine — drives the chat-led onboarding conversation.
 *
 * Each phase produces a set of EnvoyMessages (with optional numbered quick replies)
 * and optionally a widget to embed inline. The API route calls `advance()` with
 * the user's response and current phase, gets back the next messages + phase.
 */

import type { ScoredSlot } from "./scoring";
import type { CalendarEvent } from "./calendar";

// ── Types ──────────────────────────────────────────────────────────────

export type OnboardingPhase =
  | "intro"
  | "timezone"
  | "calendar_reveal"
  | "events"
  | "protection"
  | "protection_duration"
  | "protection_blocks"
  | "hours"
  | "hours_posture"
  | "format"
  | "simulation"
  | "simulation_walkthrough"
  | "complete";

export interface QuickReplyOption {
  number: number;
  label: string;
  value: string;
}

export interface EnvoyMessage {
  content: string;
  options?: QuickReplyOption[];
  delay?: number; // ms before showing (typing effect)
}

export type WidgetType =
  | "timezone-picker"
  | "calendar-reveal"
  | "hours-picker"
  | "simulated-deal-room";

export interface WidgetConfig {
  type: WidgetType;
  data: Record<string, unknown>;
}

export interface PhaseResult {
  messages: EnvoyMessage[];
  phase: OnboardingPhase;
  widget?: WidgetConfig;
  /** Structured data to persist (the API route handles the actual DB write) */
  save?: Record<string, unknown>;
}

export interface OnboardingContext {
  userName?: string;
  detectedTimezone?: string;
  meetSlug?: string;
  /** Calendar events for the event-judgment phase */
  events?: CalendarEvent[];
  /** Scored slots for the calendar reveal */
  slots?: ScoredSlot[];
  /** Events the machine picked to ask about (stored so we can iterate) */
  eventQuestions?: Array<{ event: CalendarEvent; asked: boolean; answer?: string }>;
  /** Index into eventQuestions for current question */
  eventQuestionIndex?: number;
}

// ── Phase handlers ─────────────────────────────────────────────────────

export function getIntroMessages(ctx: OnboardingContext): PhaseResult {
  const name = ctx.userName ? ctx.userName.split(" ")[0] : "there";
  return {
    phase: "intro",
    messages: [
      {
        content: `Hey ${name}! I'm Envoy. I negotiate your schedule so you don't have to.`,
        delay: 0,
      },
      {
        content: `Here's what makes this different from a regular scheduling link — you have two ways to share your availability:`,
        delay: 800,
      },
      {
        content: `1. Custom Invites — Create a tailored invite for a specific person. You control which time slots to offer, the meeting format, and how much to protect your schedule. Want to steer someone toward Tuesday morning for a quick call? Or lock down availability to just 3 slots for a VIP? Custom invites let you do that.`,
        delay: 1600,
      },
      {
        content: `2. Generic Link — Your always-on scheduling link (agentenvoy.ai/meet/${ctx.meetSlug || "you"}). Anyone can use it. It shows your general availability based on your calendar and preferences. Copy, paste, done. Great for "let's find a time" situations.`,
        delay: 2400,
      },
      {
        content: `Both are powered by your availability engine — I score every 30-minute slot on your calendar from "wide open" to "don't touch." The more context you give me, the smarter I am about what to offer.`,
        delay: 3200,
      },
      {
        content: `Let's set that up now. This'll take a few minutes, but it's worth it.`,
        delay: 4000,
        options: [{ number: 1, label: "Let's go", value: "start" }],
      },
    ],
  };
}

export function getTimezoneMessages(ctx: OnboardingContext): PhaseResult {
  const tz = ctx.detectedTimezone || "America/Los_Angeles";
  const tzLabel = tz.replace(/_/g, " ");
  return {
    phase: "timezone",
    messages: [
      {
        content: `I pulled in your Google Calendar. Let me confirm your timezone:`,
        delay: 0,
        options: [
          { number: 1, label: `${tzLabel} — that's right`, value: tz },
          { number: 2, label: "I'm somewhere else...", value: "custom" },
        ],
      },
    ],
  };
}

export function getCalendarRevealMessages(ctx: OnboardingContext): PhaseResult {
  return {
    phase: "calendar_reveal",
    messages: [
      {
        content: `Great. Here's how your week looks to me right now:`,
        delay: 0,
      },
      {
        content: `Green = open and available. Amber = soft hold (focus time, tentative). Red = protected — guests never see these.`,
        delay: 600,
        options: [{ number: 1, label: "Got it, let's keep going", value: "continue" }],
      },
    ],
    widget: {
      type: "calendar-reveal",
      data: {
        slots: ctx.slots || [],
        events: (ctx.events || []).map((e) => ({
          ...e,
          start: e.start instanceof Date ? e.start.toISOString() : e.start,
          end: e.end instanceof Date ? e.end.toISOString() : e.end,
        })),
      },
    },
  };
}

/** Pick 2-3 interesting events to ask about */
export function pickEventQuestions(events: CalendarEvent[]): CalendarEvent[] {
  const interesting: CalendarEvent[] = [];

  // Find a Focus Time
  const focusTime = events.find(
    (e) => e.eventType === "focusTime" || /focus\s*time/i.test(e.summary)
  );
  if (focusTime) interesting.push(focusTime);

  // Find a 1:1 or recurring meeting
  const oneOnOne = events.find(
    (e) =>
      e.isRecurring &&
      e.attendeeCount === 1 &&
      !interesting.includes(e)
  );
  if (oneOnOne) interesting.push(oneOnOne);

  // Find something in evening or outside standard hours
  const eveningEvent = events.find((e) => {
    const hour = e.start instanceof Date ? e.start.getHours() : new Date(e.start).getHours();
    return hour >= 17 && !interesting.includes(e);
  });

  // If no evening event, check if evenings are generally open (ask about it)
  if (eveningEvent) {
    interesting.push(eveningEvent);
  }

  // If we don't have 2 yet, grab any non-all-day event
  if (interesting.length < 2) {
    const filler = events.find(
      (e) => !e.isAllDay && !interesting.includes(e)
    );
    if (filler) interesting.push(filler);
  }

  return interesting.slice(0, 3);
}

export function getEventQuestion(
  event: CalendarEvent,
): EnvoyMessage {
  const summary = event.summary;
  const startDate = event.start instanceof Date ? event.start : new Date(event.start);
  const dayName = startDate.toLocaleDateString("en-US", { weekday: "long" });
  const timeStr = startDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const endDate = event.end instanceof Date ? event.end : new Date(event.end);
  const endStr = endDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (event.eventType === "focusTime" || /focus\s*time/i.test(summary)) {
    return {
      content: `You have Focus Time on ${dayName} ${timeStr}-${endStr}. How should I treat it?`,
      options: [
        { number: 1, label: "Protect it — never offer to guests", value: "protect" },
        { number: 2, label: "Soft hold — offer if the meeting is important", value: "soft" },
        { number: 3, label: "It's flexible — treat it like open time", value: "flexible" },
      ],
    };
  }

  if (event.isRecurring && event.attendeeCount === 1) {
    return {
      content: `You have a ${summary} on ${dayName} at ${timeStr}. If someone important needed that slot...`,
      options: [
        { number: 1, label: "Don't touch it — always protected", value: "protect" },
        { number: 2, label: "It's movable — I can suggest rescheduling", value: "movable" },
      ],
    };
  }

  // Generic event question
  return {
    content: `You have "${summary}" on ${dayName} ${timeStr}-${endStr}. How important is this?`,
    options: [
      { number: 1, label: "Protected — don't offer this slot", value: "protect" },
      { number: 2, label: "Flexible — could move it if needed", value: "flexible" },
    ],
  };
}

/** Ask about evenings if no evening event was found */
export function getEveningQuestion(): EnvoyMessage {
  return {
    content: `What about evenings — should I offer evening slots to guests?`,
    options: [
      { number: 1, label: "Evenings are fine", value: "open" },
      { number: 2, label: "Keep evenings off-limits", value: "blocked" },
      { number: 3, label: "Only for phone calls (no video)", value: "phone_only" },
    ],
  };
}

export function getProtectionMessages(): PhaseResult {
  return {
    phase: "protection",
    messages: [
      {
        content: `Now let's set up your general protection rules. These affect every invite — both custom and generic.`,
        delay: 0,
      },
      {
        content: `Buffers between meetings — how much breathing room do you need?`,
        delay: 600,
        options: [
          { number: 1, label: "No buffer needed", value: "0" },
          { number: 2, label: "10 minutes (quick breather)", value: "10" },
          { number: 3, label: "15 minutes (standard)", value: "15" },
          { number: 4, label: "30 minutes (comfortable gap)", value: "30" },
        ],
      },
    ],
  };
}

export function getProtectionDurationMessages(): PhaseResult {
  return {
    phase: "protection_duration",
    messages: [
      {
        content: `Meeting duration defaults — what length should I suggest when someone doesn't specify?`,
        options: [
          { number: 1, label: "15 minutes (quick sync)", value: "15" },
          { number: 2, label: "30 minutes (standard)", value: "30" },
          { number: 3, label: "45 minutes", value: "45" },
          { number: 4, label: "60 minutes", value: "60" },
        ],
      },
    ],
  };
}

export function getProtectionBlocksMessages(): PhaseResult {
  return {
    phase: "protection_blocks",
    messages: [
      {
        content: `Protected time blocks — anything recurring that's NOT on your calendar? Workouts, commutes, family time?\n\nJust type it out (e.g., "I surf 7-9am weekdays") or say "nothing" to skip.`,
      },
    ],
  };
}

export function getHoursMessages(): PhaseResult {
  return {
    phase: "hours",
    messages: [
      {
        content: `What working hours should I use as your baseline?`,
        options: [
          { number: 1, label: "9am - 5pm", value: "9-17" },
          { number: 2, label: "9am - 6pm", value: "9-18" },
          { number: 3, label: "10am - 6pm", value: "10-18" },
          { number: 4, label: "Custom...", value: "custom" },
        ],
      },
    ],
  };
}

export function getHoursPostureMessages(): PhaseResult {
  return {
    phase: "hours_posture",
    messages: [
      {
        content: `How aggressive should I be with your availability?`,
        options: [
          { number: 1, label: "Generous — offer whatever's open", value: "generous" },
          { number: 2, label: "Balanced — offer open slots, check before moving things", value: "balanced" },
          { number: 3, label: "Conservative — only clearly open slots", value: "conservative" },
        ],
      },
      {
        content: `Think of it this way: "generous" is great if you're building a network and want to make it easy for people to book. "Conservative" is better if your calendar is packed and every slot matters.`,
        delay: 400,
      },
    ],
  };
}

export function getFormatMessages(): PhaseResult {
  return {
    phase: "format",
    messages: [
      {
        content: `What default meeting format would you prefer?`,
        options: [
          { number: 1, label: "Phone call", value: "phone" },
          { number: 2, label: "Video (Google Meet)", value: "video" },
          { number: 3, label: "In-person", value: "in-person" },
          { number: 4, label: "No preference — let the guest decide", value: "none" },
        ],
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getSimulationMessages(ctx: OnboardingContext): PhaseResult {
  return {
    phase: "simulation",
    messages: [
      {
        content: `Before I send you to the dashboard, let's practice creating a custom invite. Nothing will be sent — I just want to show you what's possible.`,
        delay: 0,
      },
      {
        content: `Imagine you need to meet with someone named Sam about a project review this week.`,
        delay: 800,
      },
      {
        content: `Time steering — I can offer Sam your full availability, OR you can narrow it:\n- "Only offer Tuesday and Wednesday mornings"\n- "Prefer afternoons but allow mornings as fallback"\n- "Lock it to exactly 3 specific slots"`,
        delay: 1600,
      },
      {
        content: `Format control — Phone, video, or in-person. You can set conditional rules like "video if same city, phone if they're remote."`,
        delay: 2400,
      },
      {
        content: `Protection overrides — For this specific meeting, you can make slots MORE or LESS available than your defaults. Mark times as "exclusive" (only these slots offered) or "preferred" (offered first).`,
        delay: 3200,
      },
      {
        content: `Duration + context — 30 minutes, coffee chat, project review — giving me this context helps me negotiate smarter on your behalf.`,
        delay: 4000,
        options: [{ number: 1, label: "Show me what it looks like", value: "show" }],
      },
    ],
  };
}

export function getSimulationWalkthroughMessages(ctx: OnboardingContext): PhaseResult {
  return {
    phase: "simulation_walkthrough",
    messages: [
      {
        content: `Here's what it would look like if you created this invite:`,
        delay: 0,
      },
      {
        content: `When you create a real invite, you get a link like this to share — text it, email it, drop it in Slack. When Sam opens it, Envoy takes over and negotiates a time that works for both of you.`,
        delay: 600,
      },
      {
        content: `Ready to try it for real? Just tell me in the feed: "Set up a call with Sam about the project review" — and I'll create the actual invite.`,
        delay: 1200,
        options: [{ number: 1, label: "Got it, take me to the dashboard", value: "done" }],
      },
    ],
    widget: {
      type: "simulated-deal-room",
      data: {
        name: "Sam",
        topic: "Project Review",
        duration: 30,
        format: "video",
        slug: ctx.meetSlug || "you",
        slots: (ctx.slots || []).filter((s) => s.score <= 1).slice(0, 8),
      },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getCompletionMessages(ctx: OnboardingContext): PhaseResult {
  return {
    phase: "complete",
    messages: [
      {
        content: `You're all set! Your Envoy is calibrated and ready to negotiate on your behalf.\n\nFrom now on, just tell me who to meet with in the feed — I'll take it from there.`,
        delay: 0,
      },
    ],
    save: { complete: true },
  };
}

// ── Phase transition map ───────────────────────────────────────────────

const PHASE_ORDER: OnboardingPhase[] = [
  "intro",
  "timezone",
  "calendar_reveal",
  "events",
  "protection",
  "protection_duration",
  "protection_blocks",
  "hours",
  "hours_posture",
  "format",
  "simulation",
  "simulation_walkthrough",
  "complete",
];

export function nextPhase(current: OnboardingPhase): OnboardingPhase {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1 || idx >= PHASE_ORDER.length - 1) return "complete";
  return PHASE_ORDER[idx + 1];
}

export function phaseIndex(phase: OnboardingPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

export const TOTAL_PHASES = PHASE_ORDER.length;
