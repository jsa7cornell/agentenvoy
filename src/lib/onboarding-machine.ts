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
  | "rules_intro"
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
        content: `Hey ${name}! I'm Envoy — I negotiate your schedule so you don't have to.\n\nYou'll have two ways to share your availability:\n• **Custom invites** — one-off links with rules (e.g. "only Tuesday 2-4pm, video, 30 min")\n• **General link** — a permanent URL (agentenvoy.ai/meet/${ctx.meetSlug || "you"}) for your email signature\n\nBoth are powered by a scoring engine that rates every slot on your calendar. Let's set that up now.`,
        delay: 0,
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
        content: `First — I detected your timezone as **${tzLabel}**. Correct?`,
        delay: 0,
        options: [
          { number: 1, label: `Yes, ${tzLabel}`, value: tz },
          { number: 2, label: "No, let me change it", value: "custom" },
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
        content: `Here's how your week looks to me right now:\n\n🟢 **Available** — open slots I'll offer first\n🟡 **Protected** — buffers, soft holds, tentative. I can offer these if pressed\n🔴 **Blocked** — confirmed meetings, hard blocks. Off-limits\n\nNext, I'll ask about a few of your events to learn how you like to protect your time.`,
        delay: 0,
        options: [{ number: 1, label: "Sounds good", value: "continue" }],
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
        content: `Now let's set up your first availability rule — buffer time between meetings. How much breathing room do you want after each meeting?`,
        options: [
          { number: 1, label: "No buffer needed", value: "0" },
          { number: 2, label: "10 minutes", value: "10" },
          { number: 3, label: "15 minutes", value: "15" },
          { number: 4, label: "30 minutes", value: "30" },
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
        content: `What default meeting length should I suggest when someone doesn't specify?`,
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
        content: `Any recurring time that's always off-limits? (Workouts, commutes, family time — things not on your calendar.)\n\nType it naturally (e.g. "I surf 7-9am weekdays") or pick below.`,
        options: [
          { number: 1, label: "Nothing — skip this", value: "none" },
        ],
      },
    ],
  };
}

export function getHoursMessages(): PhaseResult {
  return {
    phase: "hours",
    messages: [
      {
        content: `What are your business hours? I won't offer times outside this window.`,
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
        content: `How should I handle edge cases — requests near your boundaries or protected time?`,
        options: [
          { number: 1, label: "Generous — offer whatever's open", value: "generous" },
          { number: 2, label: "Balanced — offer open slots, ask me about edge cases", value: "balanced" },
          { number: 3, label: "Conservative — only clearly open slots", value: "conservative" },
        ],
      },
    ],
  };
}

export function getFormatMessages(): PhaseResult {
  return {
    phase: "format",
    messages: [
      {
        content: `What's your default meeting format? (You can override this per-invite later.)`,
        options: [
          { number: 1, label: "Phone call", value: "phone" },
          { number: 2, label: "Video (Google Meet)", value: "video" },
          { number: 3, label: "In-person", value: "in-person" },
          { number: 4, label: "No preference", value: "none" },
        ],
      },
    ],
  };
}

export function getRulesIntroMessages(): PhaseResult {
  return {
    phase: "rules_intro",
    messages: [
      {
        content: `Your business hours and buffer are now saved as **availability rules**. You can add more anytime from your Availability page using natural language:\n\n• "Block Friday afternoons"\n• "Only available Monday 12-3"\n• "No meetings before 10am"\n\nI parse them into structured rules and the scoring engine enforces them instantly — no AI at runtime. Next, let me show you what your guests see.`,
        options: [{ number: 1, label: "Show me", value: "continue" }],
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
        content: `When you create a custom invite, you control everything:\n• **Time steering** — "only Tuesday mornings" or "prefer afternoons"\n• **Format** — phone, video, or in-person\n• **Duration + context** — "30 min project review"\n\nI negotiate with the guest on your behalf. Let me show you what they see:`,
        options: [{ number: 1, label: "Show me", value: "show" }],
      },
    ],
  };
}

export function getSimulationWalkthroughMessages(ctx: OnboardingContext): PhaseResult {
  return {
    phase: "simulation_walkthrough",
    messages: [
      {
        content: `Here's a sample invite for "Project Review — Sam." Share links like this via text, email, or Slack — when they open it, I negotiate a time on your behalf.\n\nTo create a real one, just tell me in the feed: "Set up a call with Sam about the project review."`,
        options: [{ number: 1, label: "Take me to my dashboard", value: "done" }],
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
  "rules_intro",
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
