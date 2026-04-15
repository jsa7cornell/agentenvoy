import { shortTimezoneLabel, longTimezoneLabel, getTimezoneEntry } from "./timezone";

/**
 * Onboarding state machine — drives the chat-led calibration conversation.
 *
 * Each phase produces EnvoyMessages (with optional numbered quick replies)
 * and optionally a widget to embed inline. The API route calls `advance()`
 * with the user's response and current phase, gets back next messages + phase.
 *
 * Design principles:
 *   - Every click should set something (no "Let's go" / "Sounds good" filler)
 *   - Each topic gets a contextual intro explaining what & why
 *   - Reassure user they can change settings later
 *   - Onboarding lives inside the dashboard feed — just normal Envoy chat
 */

// ── Types ──────────────────────────────────────────────────────────────

export type OnboardingPhase =
  | "intro"
  | "defaults_format"
  | "phone_number"
  | "zoom_link"
  | "defaults_duration"
  | "defaults_buffer"
  | "calendar_rules"
  | "calendar_evenings"
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

export interface PhaseResult {
  messages: EnvoyMessage[];
  phase: OnboardingPhase;
  /** Structured data to persist (the API route handles the actual DB write) */
  save?: Record<string, unknown>;
  /** If true, the phase auto-advances (no user input needed) */
  autoAdvance?: boolean;
  /** Placeholder text for freeform input phases */
  placeholder?: string;
}

export interface OnboardingContext {
  userName?: string;
  detectedTimezone?: string;
  meetSlug?: string;
  /**
   * Optional LLM-generated riff on the user's calendar, shown as the
   * very first message of onboarding. Generated in the route handler
   * (NOT the state machine — the machine stays pure) and passed in.
   * Undefined when the calendar is empty or LLM generation failed;
   * onboarding proceeds normally without the paragraph.
   */
  calendarReadParagraph?: string;
}

// ── Phase handlers ─────────────────────────────────────────────────────

// Phase 1: Welcome + Timezone
export function getIntroMessages(ctx: OnboardingContext): PhaseResult {
  const name = ctx.userName ? ctx.userName.split(" ")[0] : "there";
  const tz = ctx.detectedTimezone || "America/Los_Angeles";
  // Prefer the curated long label from the table; fall back to Intl-derived text.
  const tzLabel = `${longTimezoneLabel(tz)} (${shortTimezoneLabel(tz)})`;

  // The "for instance" wow snippet: a single calendar-grounded sentence
  // generated in the route handler and passed in via ctx. Embedded inline
  // in the greeting so it reads naturally, not as a standalone message.
  const forInstance = ctx.calendarReadParagraph
    ? ` For instance, ${ctx.calendarReadParagraph.replace(/^\s*for instance,?\s*/i, "").replace(/^[A-Z]/, (c) => c.toLowerCase())}`
    : "";

  const content =
    `Hey ${name}! I'm Envoy — I negotiate your schedule so you don't have to. ` +
    `When you need to meet with someone, I handle the back-and-forth. ` +
    `I thrive in the context of your calendar and use that to find the best time for the most important people — ` +
    `I'm personalized and context-aware.${forInstance}` +
    `\n\nLet's get you set up. Takes about a minute — mostly quick choices.` +
    `\n\nI detected your timezone as **${tzLabel}**. Correct?`;

  return {
    phase: "intro",
    messages: [
      {
        content,
        options: [
          { number: 1, label: `Yes, ${tzLabel}`, value: tz },
          { number: 2, label: "No, let me change it", value: "change_tz" },
        ],
      },
    ],
  };
}

// Phase 1b: Timezone picker (shown only if user wants to change).
// Options are driven by TIMEZONE_TABLE — single source of truth.
// A compact picker of ~9 zones from different regions keeps the quick-reply
// list short; anything not here uses "Other" → freetext.
const ONBOARDING_TIMEZONE_PICKS: string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function getTimezonePickerMessages(): PhaseResult {
  const options = ONBOARDING_TIMEZONE_PICKS.map((iana, i) => {
    const entry = getTimezoneEntry(iana);
    const label = entry
      ? `${entry.long} · ${shortTimezoneLabel(iana)}`
      : iana;
    return { number: i + 1, label, value: iana };
  });
  options.push({ number: options.length + 1, label: "Other", value: "other_tz" });

  return {
    phase: "intro",
    messages: [
      {
        content: `What timezone are you in?`,
        options,
      },
    ],
  };
}

// Phase 1c: Timezone free-text input (shown only if user picks "Other")
export function getTimezoneInputMessages(): PhaseResult {
  return {
    phase: "intro",
    messages: [
      {
        content: `Type your IANA timezone (e.g. "America/New_York", "Europe/Berlin", "Asia/Singapore").`,
      },
    ],
    placeholder: "America/New_York",
  };
}

// Phase 2a: Meeting Defaults — Format
export function getDefaultsFormatMessages(): PhaseResult {
  return {
    phase: "defaults_format",
    messages: [
      {
        content: `A few defaults I'll use for your meetings. You can always override any of these on a per-invite basis.\n\nWhat's your preferred meeting format?`,
        options: [
          { number: 1, label: "Phone call", value: "phone" },
          { number: 2, label: "Google Meet", value: "google_meet" },
          { number: 3, label: "Zoom", value: "zoom" },
          { number: 4, label: "In-person", value: "in-person" },
          { number: 5, label: "No preference — decide based on context", value: "none" },
        ],
      },
    ],
  };
}

// Phase 2b: Phone Number (only shown if user selected Phone)
export function getPhoneNumberMessages(): PhaseResult {
  return {
    phase: "phone_number",
    messages: [
      {
        content: `What's your phone number? Include country code — I'll share this with guests when setting up calls.`,
      },
    ],
    placeholder: "+1 555 123 4567",
  };
}

// Phase 2c: Zoom Link (only shown if user selected Zoom)
export function getZoomLinkMessages(): PhaseResult {
  return {
    phase: "zoom_link",
    messages: [
      {
        content: `What's your personal Zoom meeting link? I'll use this when creating video meetings for you.`,
      },
    ],
    placeholder: "https://zoom.us/j/1234567890",
  };
}

// Phase 2c: Meeting Defaults — Duration
export function getDefaultsDurationMessages(): PhaseResult {
  return {
    phase: "defaults_duration",
    messages: [
      {
        content: `How long should meetings be by default?`,
        options: [
          { number: 1, label: "15 min (quick sync)", value: "15" },
          { number: 2, label: "30 min (standard)", value: "30" },
          { number: 3, label: "45 min", value: "45" },
          { number: 4, label: "60 min", value: "60" },
        ],
      },
    ],
  };
}

// Phase 2d: Meeting Defaults — Buffer
export function getDefaultsBufferMessages(): PhaseResult {
  return {
    phase: "defaults_buffer",
    messages: [
      {
        content: `How much buffer time do you want after each meeting?`,
        options: [
          { number: 1, label: "No buffer", value: "0" },
          { number: 2, label: "10 minutes", value: "10" },
          { number: 3, label: "15 minutes", value: "15" },
          { number: 4, label: "30 minutes", value: "30" },
        ],
      },
    ],
  };
}

// Phase 3a: Calendar Rules — Business Hours
export function getCalendarRulesMessages(): PhaseResult {
  return {
    phase: "calendar_rules",
    messages: [
      {
        content: `What are your business hours? I won't offer times outside this window without your direction.`,
        options: [
          { number: 1, label: "8am – 5pm", value: "8-17" },
          { number: 2, label: "9am – 5pm", value: "9-17" },
          { number: 3, label: "9am – 6pm", value: "9-18" },
          { number: 4, label: "10am – 6pm", value: "10-18" },
          { number: 5, label: "Flexible — no restrictions", value: "0-24" },
        ],
      },
    ],
  };
}

// Phase 3b: Calendar Rules — Evenings
export function getCalendarEveningsMessages(): PhaseResult {
  return {
    phase: "calendar_evenings",
    messages: [
      {
        content: `How about evenings?`,
        options: [
          { number: 1, label: "Evenings are fine", value: "open" },
          { number: 2, label: "Only offer evenings with my permission", value: "blocked" },
        ],
      },
    ],
  };
}

// Phase 4: Complete
export function getCompleteMessages(ctx: OnboardingContext): PhaseResult {
  const slug = ctx.meetSlug || "you";
  return {
    phase: "complete",
    messages: [
      {
        content: `You're all set! Here are some things for you to do:\n\n**1.** [Fine-tune your availability](/dashboard/availability) using natural language rules like "block Friday afternoons" or "no meetings before 10am." Definitely go do that.\n\n**2. General link:** agentenvoy.ai/meet/${slug} — share it in your email signature. It offers up general times for a meeting using the availability you set up.\n\n**3.** The most powerful thing is **custom invite links**. When you need to meet with somebody, tell me and I'll create a link in real time with your rules baked in — time window, format, duration, everything.\n\nWant to try? Type something like "Create a meeting with Joe via VC next week"`,
      },
    ],
    save: { complete: true },
  };
}

// ── Phase transition map ───────────────────────────────────────────────

const PHASE_ORDER: OnboardingPhase[] = [
  "intro",
  "defaults_format",
  "phone_number",
  "zoom_link",
  "defaults_duration",
  "defaults_buffer",
  "calendar_rules",
  "calendar_evenings",
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
