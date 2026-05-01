/**
 * Per-step handlers for the primary-link tuning flow. Each step owns:
 *   - the Envoy prompt (message text + quick-reply options)
 *   - the side effect that runs on a valid answer (preference write)
 *   - the next step in the sequence
 *
 * Shape mirrors the legacy `onboarding-machine` per-phase functions, but
 * the state machine is local to this flow (5 steps, deterministic order)
 * rather than a project-wide enum. See proposal `2026-04-30_onboarding-and-tuning-as-chat`.
 */

import type { EnvoyMessage, QuickReplyOption } from "@/lib/onboarding-machine";

export type PrimaryLinkStep =
  | "timezone"
  | "hours"
  | "duration"
  | "format"
  | "guest_flex"
  | "complete";

export const STEP_ORDER: PrimaryLinkStep[] = [
  "timezone",
  "hours",
  "duration",
  "format",
  "guest_flex",
  "complete",
];

export interface StepPrompt {
  step: PrimaryLinkStep;
  messages: EnvoyMessage[];
  /** When `true`, the route should not render quick-reply options — the
   *  client renders a freetext input instead (timezone "Other / not sure"
   *  or hours "Custom hours"). */
  freetextHint?: "timezone-other" | "hours-custom";
}

// ── Common option sets ────────────────────────────────────────────────

const UNSURE_OPTION: QuickReplyOption = {
  number: 99,
  label: "I'm not sure right now",
  value: "__unsure__",
};

const TIMEZONE_OPTIONS_BASE: { label: string; value: string }[] = [
  { label: "America/Los_Angeles", value: "America/Los_Angeles" },
  { label: "America/Denver", value: "America/Denver" },
  { label: "America/Chicago", value: "America/Chicago" },
  { label: "America/New_York", value: "America/New_York" },
  { label: "Europe/London", value: "Europe/London" },
  { label: "Asia/Tokyo", value: "Asia/Tokyo" },
];

export const HOURS_OPTIONS: QuickReplyOption[] = [
  { number: 1, label: "8am – 4pm", value: "8-16" },
  { number: 2, label: "9am – 5pm", value: "9-17" },
  { number: 3, label: "9am – 6pm", value: "9-18" },
  { number: 4, label: "10am – 6pm", value: "10-18" },
  { number: 5, label: "Flexible — no restrictions", value: "0-24" },
  { number: 6, label: "Custom hours (type your own)", value: "__custom__" },
  { ...UNSURE_OPTION, number: 7 },
];

export const DURATION_OPTIONS: QuickReplyOption[] = [
  { number: 1, label: "30 minutes", value: "30" },
  { number: 2, label: "45 minutes", value: "45" },
  { number: 3, label: "60 minutes", value: "60" },
  { number: 4, label: "15 minutes (quick sync)", value: "15" },
  { ...UNSURE_OPTION, number: 5 },
];

export const FORMAT_OPTIONS: QuickReplyOption[] = [
  { number: 1, label: "Video call", value: "video" },
  { number: 2, label: "Phone call", value: "phone" },
  { number: 3, label: "In-person", value: "in-person" },
  { ...UNSURE_OPTION, number: 4 },
];

export const GUEST_FLEX_OPTIONS: QuickReplyOption[] = [
  { number: 1, label: "Just what I posted — no changes", value: "locked" },
  {
    number: 2,
    label: "Format flexibility — phone, video, or in-person are all OK",
    value: "format",
  },
  {
    number: 3,
    label: "Duration flexibility — longer or shorter slots are OK",
    value: "duration",
  },
  { number: 4, label: "Both — format and duration are open", value: "both" },
  {
    number: 5,
    label: "Only for VIPs — flexibility for select people, locked otherwise",
    value: "vip_only",
  },
  { ...UNSURE_OPTION, number: 6 },
];

function tzOptions(browserTz: string | null): QuickReplyOption[] {
  const opts: QuickReplyOption[] = [];
  let n = 1;
  if (browserTz) {
    opts.push({
      number: n++,
      label: `Yes, ${browserTz} is right`,
      value: browserTz,
    });
  }
  for (const o of TIMEZONE_OPTIONS_BASE) {
    if (o.value === browserTz) continue;
    opts.push({ number: n++, label: o.label, value: o.value });
  }
  // Timezone is non-skippable — no `__unsure__` option here. The freetext
  // affordance below catches users who don't recognize any of the above.
  opts.push({ number: n++, label: "Other / not sure", value: "__other__" });
  return opts;
}

// ── Step prompts ──────────────────────────────────────────────────────

export function timezonePrompt(browserTz: string | null): StepPrompt {
  const tzText = browserTz ? `I'm seeing **${browserTz}** for you` : `I don't have a timezone for you yet`;
  return {
    step: "timezone",
    messages: [
      {
        content: `Before we tune your meeting defaults, let me confirm your timezone. ${tzText} — is that right?`,
        options: tzOptions(browserTz),
      },
    ],
  };
}

export function timezoneOtherPrompt(): StepPrompt {
  return {
    step: "timezone",
    messages: [
      {
        content:
          "No problem — type your timezone (e.g. `America/Phoenix`, `Europe/Berlin`). Most IANA timezones work.",
      },
    ],
    freetextHint: "timezone-other",
  };
}

export function hoursPrompt(): StepPrompt {
  return {
    step: "hours",
    messages: [
      { content: "What ordinary available hours should we offer up?" },
      {
        content: "_(You can always customize this later, or per-link.)_",
        options: HOURS_OPTIONS,
      },
    ],
  };
}

export function hoursCustomPrompt(): StepPrompt {
  return {
    step: "hours",
    messages: [
      {
        content:
          'Type your hours (e.g. `8:30 to 5:30` or `9am-6pm`). Times must be on the half hour.',
      },
    ],
    freetextHint: "hours-custom",
  };
}

export function durationPrompt(): StepPrompt {
  return {
    step: "duration",
    messages: [
      { content: "…and what's your default meeting length?" },
      {
        content: "_(You can always customize this later, or per-link.)_",
        options: DURATION_OPTIONS,
      },
    ],
  };
}

export function formatPrompt(): StepPrompt {
  return {
    step: "format",
    messages: [
      {
        content: "What's your default meeting format — video, phone, or in person?",
      },
      {
        content: "_(You can always customize this later, or per-link.)_",
        options: FORMAT_OPTIONS,
      },
    ],
  };
}

export function guestFlexPrompt(durationLabel: string, formatShort: string): StepPrompt {
  return {
    step: "guest_flex",
    messages: [
      {
        content: `If a guest asks to adjust the format or duration from your standard **${durationLabel} ${formatShort}**, how should I handle it?`,
        options: GUEST_FLEX_OPTIONS,
      },
    ],
  };
}

export function completePrompt(summary: string): StepPrompt {
  return {
    step: "complete",
    messages: [{ content: summary }],
  };
}

// ── Helpers for parsing answers ───────────────────────────────────────

export function parseHoursValue(value: string): { startMinutes: number; endMinutes: number } | null {
  const [sRaw, eRaw] = value.split("-");
  const s = parseInt(sRaw, 10);
  const e = parseInt(eRaw, 10);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return { startMinutes: s * 60, endMinutes: e * 60 };
}

export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h < 12 || h === 24 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0 ? `${h12}${suffix}` : `${h12}:${String(min).padStart(2, "0")}${suffix}`;
}

export function nextStepAfter(step: PrimaryLinkStep): PrimaryLinkStep {
  const i = STEP_ORDER.indexOf(step);
  if (i < 0 || i >= STEP_ORDER.length - 1) return "complete";
  return STEP_ORDER[i + 1];
}
