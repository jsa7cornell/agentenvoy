/**
 * Per-step handlers for the preferences-extended ("Fine-tune your
 * availability + theme") continuation flow. Runs after the primary-link
 * tuning flow completes; same persist invariant (SPEC §6.6); messages
 * land with `metadata: { kind: "onboarding", subkind: "preferences-extended", step }`.
 *
 * Steps:
 *   buffer        → preferences.explicit.bufferMinutes
 *   custom_rules  → appends a structuredRules entry (recurring block)
 *   evenings      → preferences.explicit.eveningsPosture
 *   theme         → preferences.explicit.themeMode (via /api/me/ui-prefs shape)
 *   complete      → terminal summary
 */

import type { EnvoyMessage, QuickReplyOption } from "@/lib/onboarding-machine";

export type ExtendedStep =
  | "buffer"
  | "custom_rules"
  | "evenings"
  | "theme"
  | "complete";

export const EXTENDED_STEP_ORDER: ExtendedStep[] = [
  "buffer",
  "custom_rules",
  "evenings",
  "theme",
  "complete",
];

export interface ExtendedStepPrompt {
  step: ExtendedStep;
  messages: EnvoyMessage[];
}

const UNSURE_OPTION: QuickReplyOption = {
  number: 99,
  label: "I'm not sure right now",
  value: "__unsure__",
};

export const BUFFER_OPTIONS: QuickReplyOption[] = [
  { number: 1, label: "No buffer — back-to-back is fine", value: "0" },
  { number: 2, label: "5 minutes between meetings", value: "5" },
  { number: 3, label: "10 minutes between meetings", value: "10" },
  { number: 4, label: "15 minutes between meetings", value: "15" },
  { number: 5, label: "30 minutes between meetings", value: "30" },
  { ...UNSURE_OPTION, number: 6 },
];

/**
 * Common "block-off" rule templates. Each value identifies a deterministic
 * rule shape the route handler stamps into structuredRules. Keeping the
 * vocabulary small for v1 — richer rule authoring lives in chat (Progressive
 * Profiling intent router → `update_availability_rule`).
 */
export const CUSTOM_RULES_OPTIONS: QuickReplyOption[] = [
  { number: 1, label: "Block lunch hour (12–1pm, weekdays)", value: "lunch" },
  { number: 2, label: "Block Friday afternoons (after 12pm)", value: "fri_pm" },
  { number: 3, label: "Block Monday mornings (before 10am)", value: "mon_am" },
  { number: 4, label: "I'll add custom rules in chat later", value: "__defer__" },
  { ...UNSURE_OPTION, number: 5 },
];

export const EVENINGS_OPTIONS: QuickReplyOption[] = [
  { number: 1, label: "Avoid evenings — protect personal time", value: "protect" },
  { number: 2, label: "Open to evenings if needed", value: "flexible" },
  { number: 3, label: "Evenings are fine, no special rules", value: "open" },
  { ...UNSURE_OPTION, number: 4 },
];

export const THEME_OPTIONS: QuickReplyOption[] = [
  { number: 1, label: "Light mode", value: "light" },
  { number: 2, label: "Dark mode", value: "dark" },
  { number: 3, label: "Match my system", value: "auto" },
  { ...UNSURE_OPTION, number: 4 },
];

// ── Step prompts ──────────────────────────────────────────────────────

export function bufferPrompt(): ExtendedStepPrompt {
  return {
    step: "buffer",
    messages: [
      {
        content:
          "Let's fine-tune your availability. First — how much buffer do you want between meetings?\n\n_(I'll keep this much breathing room around each invite.)_",
        options: BUFFER_OPTIONS,
      },
    ],
  };
}

export function customRulesPrompt(): ExtendedStepPrompt {
  return {
    step: "custom_rules",
    messages: [
      {
        content:
          "Any times you'd like blocked off recurringly?\n\n_(Pick a common pattern, or say you'll add specifics in chat later — you can describe rules in plain English anytime.)_",
        options: CUSTOM_RULES_OPTIONS,
      },
    ],
  };
}

export function eveningsPrompt(): ExtendedStepPrompt {
  return {
    step: "evenings",
    messages: [
      {
        content:
          "How should I handle evening slots — protect them, or are evenings open?\n\n_(\"Open if needed\" lets me offer evenings only when the day is otherwise full.)_",
        options: EVENINGS_OPTIONS,
      },
    ],
  };
}

export function themePrompt(): ExtendedStepPrompt {
  return {
    step: "theme",
    messages: [
      {
        content: "Last one — light or dark?",
        options: THEME_OPTIONS,
      },
    ],
  };
}

export function extendedCompletePrompt(): ExtendedStepPrompt {
  return {
    step: "complete",
    messages: [
      {
        content:
          "All tuned up. You can revisit any of these in chat anytime — just tell me what to change.",
      },
    ],
  };
}

export function nextExtendedStepAfter(step: ExtendedStep): ExtendedStep {
  const i = EXTENDED_STEP_ORDER.indexOf(step);
  if (i < 0 || i >= EXTENDED_STEP_ORDER.length - 1) return "complete";
  return EXTENDED_STEP_ORDER[i + 1];
}

/**
 * Map a CUSTOM_RULES_OPTIONS value → a structured AvailabilityPreference
 * shape. Returns null for `__defer__`, `__unsure__`, or unknown values.
 * Caller fills in id/createdAt/status/priority and appends to
 * `preferences.explicit.structuredRules[]`.
 */
export function customRuleTemplateToShape(
  value: string,
): {
  type: "recurring";
  action: "block";
  timeStart: string;
  timeEnd: string;
  daysOfWeek: number[];
  originalText: string;
} | null {
  if (value === "lunch") {
    return {
      type: "recurring",
      action: "block",
      timeStart: "12:00",
      timeEnd: "13:00",
      daysOfWeek: [1, 2, 3, 4, 5],
      originalText: "Block lunch hour (12–1pm, weekdays)",
    };
  }
  if (value === "fri_pm") {
    return {
      type: "recurring",
      action: "block",
      timeStart: "12:00",
      timeEnd: "23:59",
      daysOfWeek: [5],
      originalText: "Block Friday afternoons (after 12pm)",
    };
  }
  if (value === "mon_am") {
    return {
      type: "recurring",
      action: "block",
      timeStart: "00:00",
      timeEnd: "10:00",
      daysOfWeek: [1],
      originalText: "Block Monday mornings (before 10am)",
    };
  }
  return null;
}
