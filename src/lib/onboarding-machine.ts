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
  // Legacy phase values — no longer part of the active PHASE_ORDER. The
  // `defaults_confirm` beat was sunset 2026-04-23 per proposal
  // `2026-04-23_primary-link-config-convergence` §4 V1 item 5: its review
  // card now renders as a seed-preview bubble inlined with "complete",
  // and tuning happens via the 🔗 primary-link flow on the welcome page.
  // Kept in the union so stored `User.onboardingPhase` values from
  // in-flight users still type-check; `nextPhase()` auto-promotes any of
  // these to `complete`.
  | "defaults_confirm"
  | "defaults_format"
  | "phone_number"
  | "zoom_link"
  | "defaults_duration"
  | "defaults_buffer"
  | "calendar_rules"
  | "calendar_rules_custom"
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
  /**
   * Seeded defaults surfaced by the `defaults_confirm` phase (proposal §2.7).
   * Route handler reads `User.preferences.explicit` (which was seeded at
   * createUser-time by `buildSeededExplicit`) and merges in any user
   * modifications before passing this to the state machine. Any missing
   * field falls back to the seed value in `getDefaultsConfirmMessages`.
   */
  seededDefaults?: {
    businessHoursStart?: number;
    businessHoursEnd?: number;
    defaultFormat?: string;
    videoProvider?: string;
    defaultDuration?: number;
    bufferMinutes?: number;
  };
}

// ── Phase handlers ─────────────────────────────────────────────────────

// Phase 1: Welcome
// Tz is seeded from the browser (or Google Calendar settings) before onboarding
// runs; we mention it conversationally so a wrong guess is cheap to correct in
// normal chat later, but never blocks the first turn. No quick-replies, no
// phase gate — intro auto-advances to the next active phase after a brief dwell.
export function getIntroMessages(ctx: OnboardingContext): PhaseResult {
  const name = ctx.userName ? ctx.userName.split(" ")[0] : "there";
  const tz = ctx.detectedTimezone || "America/Los_Angeles";
  const tzLabel = `${longTimezoneLabel(tz)} (${shortTimezoneLabel(tz)})`;

  const forInstance = ctx.calendarReadParagraph
    ? ` For instance, ${ctx.calendarReadParagraph.replace(/^\s*for instance,?\s*/i, "").replace(/^[A-Z]/, (c) => c.toLowerCase())}`
    : "";

  const content =
    `Hey ${name}! I'm Envoy — I negotiate your schedule so you don't have to. ` +
    `When you need to meet with someone, I handle the back-and-forth. ` +
    `I thrive in the context of your calendar and use that to find the best time for the most important people — ` +
    `I'm personalized and context-aware.${forInstance}` +
    `\n\nI'm assuming you're in **${tzLabel}** — just say the word if I've got that wrong.` +
    `\n\nLet's get you set up. Takes about a minute — mostly quick choices.`;

  return {
    phase: "intro",
    messages: [{ content }],
    autoAdvance: true,
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
          { number: 2, label: "5 minutes", value: "5" },
          { number: 3, label: "10 minutes", value: "10" },
          { number: 4, label: "15 minutes", value: "15" },
          { number: 5, label: "30 minutes", value: "30" },
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
          { number: 6, label: "Let me set my own hours", value: "custom_hours" },
        ],
      },
    ],
  };
}

// Phase 3a-custom: freetext start/end hours.
// Accepts formats like "9-17", "9am-5pm", "8:30am - 5:30pm", "8:30 - 17:30".
// Parsing lives in the route handler so the state machine stays pure — here
// we just prompt.
export function getCalendarRulesCustomMessages(): PhaseResult {
  return {
    phase: "calendar_rules_custom",
    messages: [
      {
        content: `What hours work? Tell me a start and end — e.g. "8:30am – 5:30pm" or "9 – 18".`,
      },
    ],
    placeholder: "8:30am – 5:30pm",
  };
}

// Phase 3b: Calendar Rules — Evenings & early mornings
// Default posture is protected: never offered without the host's explicit
// direction. For VIP / high-priority guests Envoy may surface an out-of-hours
// slot as "this is outside your normal hours — offer anyway?" rather than
// including it silently. The three options below map to three postures.
export function getCalendarEveningsMessages(): PhaseResult {
  return {
    phase: "calendar_evenings",
    messages: [
      {
        content: `How about evenings and early mornings?`,
        options: [
          {
            number: 1,
            label: "Protected — never offer without my say-so",
            value: "protected",
          },
          {
            number: 2,
            label: "Protected, but OK to offer for VIPs / high-priority",
            value: "vip_only",
          },
          { number: 3, label: "Open — fine to offer freely", value: "open" },
        ],
      },
    ],
  };
}

// Phase 2: Defaults confirm (seed-and-show — proposal §2.7)
// Renders the seeded defaults as a bullet list in a single Envoy message and
// asks the user to confirm or branch out to edit. One quick-reply button —
// "Looks good, let's go" — advances to `complete`. A markdown link to the
// tuner page is inlined for users who want to change values now.
function formatHourRange(start?: number, end?: number): string {
  const s = typeof start === "number" ? start : 9;
  const e = typeof end === "number" ? end : 17;
  const fmt = (h: number) => {
    const ampm = h >= 12 ? "pm" : "am";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}${ampm}`;
  };
  return `${fmt(s)}–${fmt(e)}`;
}

function formatFormat(defaultFormat?: string, videoProvider?: string): string {
  if (defaultFormat === "phone") return "Phone";
  if (defaultFormat === "in_person") return "In-person";
  // "video" (or unset) → name the provider for specificity
  if (videoProvider === "zoom") return "Zoom";
  return "Google Meet";
}

export function getDefaultsConfirmMessages(ctx: OnboardingContext): PhaseResult {
  const d = ctx.seededDefaults ?? {};
  const hours = formatHourRange(d.businessHoursStart, d.businessHoursEnd);
  const format = formatFormat(d.defaultFormat, d.videoProvider);
  const duration = typeof d.defaultDuration === "number" ? d.defaultDuration : 30;
  const buffer = typeof d.bufferMinutes === "number" ? d.bufferMinutes : 0;
  const bufferText = buffer === 0 ? "No buffer" : `${buffer}-min buffer`;
  // Theme defaults to auto for new users. We don't read the seeded value
  // here because themeMode isn't part of seededDefaults — it's set to
  // "auto" implicitly by the ThemePreferenceSync's absent-value fallback
  // and persisted on the first toggle.
  const themeLine = "Auto (light during day, dark 8pm–5am)";

  // Only offer "Use Zoom instead" when we seeded Google Meet as the default.
  // If the user already landed on Zoom (unusual at this stage), skip the
  // inline switch — they're already where they want.
  const seededProvider = d.videoProvider === "zoom" ? "zoom" : "google_meet";
  const options =
    seededProvider === "google_meet"
      ? [
          { number: 1, label: "Looks good, let's go", value: "confirm" },
          { number: 2, label: "Use Zoom instead", value: "use_zoom" },
        ]
      : [{ number: 1, label: "Looks good, let's go", value: "confirm" }];

  const content =
    `I've seeded you with sensible defaults so you can start scheduling right away:\n\n` +
    `• **Meeting hours:** ${hours}\n` +
    `• **Format:** ${format}\n` +
    `• **Duration:** ${duration} minutes\n` +
    `• **Buffer between meetings:** ${bufferText}\n` +
    `• **Theme:** ${themeLine}\n\n` +
    `You can change any of these anytime — just tell me in chat ("no, make my hours 10–6") or tweak them on the [preferences page ↗](/dashboard/tuner).`;

  return {
    phase: "defaults_confirm",
    messages: [{ content, options }],
  };
}

// Phase 4: Complete — now includes the inlined seed-preview bubble that the
// sunset `defaults_confirm` phase used to own (proposal
// `2026-04-23_primary-link-config-convergence` §4 V1 item 5). Tuning
// happens on the welcome page's 🔗 primary-link flow; mid-session changes
// go through normal chat.
export function getCompleteMessages(ctx: OnboardingContext): PhaseResult {
  const slug = ctx.meetSlug || "you";
  const d = ctx.seededDefaults ?? {};
  const hours = formatHourRange(d.businessHoursStart, d.businessHoursEnd);
  const format = formatFormat(d.defaultFormat, d.videoProvider);
  const duration = typeof d.defaultDuration === "number" ? d.defaultDuration : 30;
  const buffer = typeof d.bufferMinutes === "number" ? d.bufferMinutes : 0;
  const bufferText = buffer === 0 ? "No buffer" : `${buffer}-min buffer`;

  const preview =
    `I've seeded you with sensible defaults so you can start scheduling right away:\n\n` +
    `• **Meeting hours:** ${hours}\n` +
    `• **Format:** ${format}\n` +
    `• **Duration:** ${duration} minutes\n` +
    `• **Buffer between meetings:** ${bufferText}\n\n` +
    `Tap the **🔗 primary link** card above to tune hours, duration, and buffer, or just tell me in chat ("use Zoom instead", "make my hours 10–6"). Everything's editable anytime.`;

  return {
    phase: "complete",
    messages: [
      { content: preview },
      {
        content: `You're all set! Your link is **agentenvoy.ai/meet/${slug}** — put it in your email signature and anyone can schedule with you.\n\nLet me show you how this works. I'm drafting a quick 5-minute meet & greet with John Anderson, the founder of AgentEnvoy, so you can see me in action. Watch what happens...`,
      },
    ],
    save: { complete: true },
  };
}

// ── Phase transition map ───────────────────────────────────────────────

// PHASE_ORDER is the active sequence for new users (post-2026-04-21 lean
// onboarding proposal). Legacy phase handlers above are retained in the
// file for Proposal 3 (Progressive Profiling) reuse, but they no longer
// appear here — new users never enter them. Mid-flow users whose stored
// `User.onboardingPhase` holds a removed value are auto-promoted past the
// trim via nextPhase() — see proposal §2.1.1.
export const PHASE_ORDER = [
  "intro",
  "complete",
] as const satisfies readonly OnboardingPhase[];

/**
 * The subset of `OnboardingPhase` values still in the live phase sequence.
 * Proposal 3 (decided 2026-04-21 §2.1) uses this type where the caller
 * needs to exclude the legacy phases retained in `OnboardingPhase` for
 * in-flight users — e.g., activity/progress narration keyed on the live
 * phase set.
 */
export type ActivePhase = typeof PHASE_ORDER[number];

export function nextPhase(current: OnboardingPhase): OnboardingPhase {
  const idx = (PHASE_ORDER as readonly OnboardingPhase[]).indexOf(current);
  // Legacy phase not in the active list (including the sunset
  // `defaults_confirm`) → jump straight to `complete`. The complete
  // message inlines the seed-preview bubble; tuning happens on the
  // welcome page's 🔗 primary-link flow.
  if (idx === -1) return "complete";
  if (idx >= PHASE_ORDER.length - 1) return "complete";
  return PHASE_ORDER[idx + 1];
}

export function phaseIndex(phase: OnboardingPhase): number {
  return (PHASE_ORDER as readonly OnboardingPhase[]).indexOf(phase);
}

export const TOTAL_PHASES = PHASE_ORDER.length;
