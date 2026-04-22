/**
 * Single read path for schedulingMode derivation.
 * All consumers import from here — prevents per-surface drift (Rule 14).
 *
 * "date" mode: guest picks a calendar date; host's startTime applies at confirm.
 * "time" mode: guest picks a specific start time (current default behavior).
 *
 * Computed from rules.duration for v1. A stored override field can be added
 * later without touching any consumer.
 */

interface RulesWithDuration {
  duration?: number | null;
}

export type SchedulingMode = "time" | "date";

export const MULTI_DAY_THRESHOLD_MINUTES = 24 * 60; // 1440

export function getSchedulingMode(rules: RulesWithDuration): SchedulingMode {
  return (rules.duration ?? 0) >= MULTI_DAY_THRESHOLD_MINUTES ? "date" : "time";
}
