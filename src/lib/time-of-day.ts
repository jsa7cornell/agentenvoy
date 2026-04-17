/**
 * Time-of-day constants and parsing.
 *
 * When a host says "this afternoon", "tomorrow morning", etc., we clamp the
 * offerable window to these hours IN THE HOST'S TIMEZONE — not UTC, not the
 * guest's. Anchoring to host tz keeps the semantics consistent with how the
 * host thought about the ask when they typed the directive.
 *
 * Hours are 0–23 on a 24h clock. End hour is exclusive (e.g., afternoon is
 * 12:00–17:00, so a slot starting at 17:00 is NOT "afternoon").
 */

export interface TimeOfDayWindow {
  startHour: number;
  endHour: number;
}

export const TIME_OF_DAY_WINDOWS: Record<string, TimeOfDayWindow> = {
  morning:   { startHour: 7,  endHour: 12 },
  afternoon: { startHour: 12, endHour: 17 },
  evening:   { startHour: 17, endHour: 21 },
};

const PHRASE_TO_KEY: Array<[RegExp, keyof typeof TIME_OF_DAY_WINDOWS]> = [
  [/\bmorning(s)?\b/i, "morning"],
  [/\bafternoon(s)?\b/i, "afternoon"],
  [/\bevening(s)?\b/i, "evening"],
];

/**
 * Detect a time-of-day phrase in free text ("this afternoon", "tomorrow
 * morning") and return the matching window. Returns null if none match.
 *
 * Only one window is returned (the first match in phrase order). Callers
 * that need multiple (e.g., "morning or afternoon") should tokenize.
 */
export function parseTimeOfDay(text: string | null | undefined): TimeOfDayWindow | null {
  if (!text) return null;
  for (const [pattern, key] of PHRASE_TO_KEY) {
    if (pattern.test(text)) return TIME_OF_DAY_WINDOWS[key];
  }
  return null;
}

/**
 * True if the slot's start time falls inside the window, evaluated in the
 * given IANA timezone. Slots that start exactly at `endHour` are excluded
 * (end is exclusive), matching how "afternoon ends at 5" reads intuitively.
 */
export function slotStartInWindow(
  slotStartIso: string,
  window: TimeOfDayWindow,
  timezone: string,
): boolean {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: timezone,
  })
    .formatToParts(new Date(slotStartIso))
    .find((p) => p.type === "hour")?.value;
  if (!hourStr) return true; // fail-open: if TZ parse fails, don't over-filter
  // Intl "hour:numeric hour12:false" can return "24" at midnight in some locales.
  const hour = Number(hourStr) === 24 ? 0 : Number(hourStr);
  return hour >= window.startHour && hour < window.endHour;
}
