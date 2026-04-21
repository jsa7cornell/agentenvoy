/**
 * Deterministic parser for bare time references in guest chat messages.
 *
 * Shipped with the guest timezone UX rework (2026-04-21) to prevent the class
 * of LLM-tz drift we've repeatedly seen ("Envoy silently misinterpreted 3pm
 * as host-tz when the guest meant viewer-tz"). The LLM never interprets the
 * time itself — this parser extracts structured references, the composer
 * attaches them to [GROUND TRUTH], and the LLM composes prose around
 * already-interpreted data.
 *
 * Rule: bare times in a guest message are interpreted in the VIEWER'S tz
 * (the tz the calendar card is currently rendering in — tracked via
 * NegotiationSession.viewerTimezone). On parse ambiguity (e.g. "at 2" with
 * no am/pm) the parser flags `ambiguous: true` and Envoy's reply explicitly
 * asks; the affirmative default implied by the ask is still viewer tz.
 *
 * Scope (v1):
 *   - bare clock times: "3pm", "3:30pm", "3 PM", "15:00"
 *   - day-anchored times: "tomorrow at 3", "Thursday 10am", "Monday 2pm"
 *   - am/pm optional; when missing the parse is flagged ambiguous unless the
 *     24-hour form (>= 13 or ":" with 00-23 hour) forces a reading
 *   - multiple references in one message → all returned
 *
 * Out of scope (v1):
 *   - fuzzy timings ("morning", "afternoon", "end of day") — let the LLM
 *     field these; the [GROUND TRUTH] is silent for these cases
 *   - timezones inline ("3pm ET") — if the guest specifies a tz, the LLM
 *     should respect it; v2 can extend the parser to capture `explicitTz`
 *   - date ranges ("between 2 and 4")
 *   - rolled-over midnight ("midnight" = 12am = 00:00)
 */

export interface ParsedTimeReference {
  /** Source snippet from the message, as-typed. */
  raw: string;
  /** Hour in 24h form if a clear reading exists, else null when ambiguous. */
  hour: number | null;
  /** Minutes (0-59). Defaults to 0 when not specified. */
  minute: number;
  /**
   * Day anchor as the guest wrote it, lowercased. Values:
   *   - "today" | "tomorrow" | weekday ("monday".."sunday") | null
   * Null means "whichever day context suggests" — the LLM/caller resolves
   * against the slot window on its side.
   */
  dayAnchor: string | null;
  /** True when the parse needs clarification from Envoy. */
  ambiguous: boolean;
  /**
   * Populated when hour is known — the viewer-tz IANA string handed to the
   * caller. The parser itself doesn't resolve to a UTC instant; that's the
   * composer/caller's job once dayAnchor is resolved.
   */
  viewerTimezone: string;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

// Match:
//   - optional day anchor: "tomorrow", "today", weekday name (+ optional "at")
//   - clock: H or H:MM (1-2 digit hour, optional :MM)
//   - optional am/pm (case-insensitive; "a.m."/"p.m." allowed)
// Examples that should match:
//   "3pm", "3 pm", "3:30pm", "3:30 PM", "15:00",
//   "tomorrow at 3", "Tuesday 10am", "monday at 2:30 pm"
const TIME_RE =
  /\b(?:(today|tomorrow|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*(?:at\s+)?)?([0-1]?\d|2[0-3])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/gi;

function normalizeWeekday(token: string | undefined): string | null {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower === "today" || lower === "tomorrow") return lower;
  const prefix3 = lower.slice(0, 3);
  const hit = WEEKDAYS.find((w) => w.startsWith(prefix3));
  return hit ?? null;
}

/**
 * Parse all bare time references in `message`, returning an array of
 * structured references (possibly empty). Ambiguous references are included
 * with `ambiguous: true`.
 */
export function parseGuestTimeReferences(
  message: string,
  viewerTimezone: string,
): ParsedTimeReference[] {
  if (!message || typeof message !== "string") return [];
  if (!viewerTimezone) return [];

  const refs: ParsedTimeReference[] = [];
  const seen = new Set<string>();

  // Reset regex state between calls.
  TIME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIME_RE.exec(message)) !== null) {
    const [raw, dayToken, hourToken, minuteToken, meridiemToken] = match;

    // Filter false positives: standalone small numbers with no clock
    // punctuation, no am/pm, and no day anchor are almost never time
    // references ("call me at 5" is rare; "$3 for lunch" is common). Require
    // at least ONE disambiguating signal.
    const hasMinute = !!minuteToken;
    const hasMeridiem = !!meridiemToken;
    const hasDayAnchor = !!dayToken;
    if (!hasMinute && !hasMeridiem && !hasDayAnchor) {
      // Bare 1-2 digit number — skip. Too noisy.
      continue;
    }

    const rawHour = parseInt(hourToken, 10);
    const minute = minuteToken ? parseInt(minuteToken, 10) : 0;
    const dayAnchor = normalizeWeekday(dayToken);

    let hour: number | null = null;
    let ambiguous = false;

    if (hasMeridiem) {
      const isPm = /^p/i.test(meridiemToken);
      // 12am → 0, 12pm → 12, otherwise add 12 for pm
      if (rawHour === 12) {
        hour = isPm ? 12 : 0;
      } else if (rawHour >= 1 && rawHour <= 11) {
        hour = isPm ? rawHour + 12 : rawHour;
      } else {
        // 13pm, etc. — nonsense; treat as ambiguous
        ambiguous = true;
      }
    } else if (rawHour >= 13 && rawHour <= 23) {
      // Unambiguous 24-hour form.
      hour = rawHour;
    } else if (hasMinute && rawHour >= 0 && rawHour <= 23) {
      // "15:00" handled above; "9:00" / "3:30" without meridiem is still
      // ambiguous between AM and PM (3:30 could be either).
      ambiguous = true;
    } else {
      // bare "3 tomorrow" — ambiguous until confirmed
      ambiguous = true;
    }

    // Dedup on (normalized form) so "3pm 3pm" in one message doesn't double.
    const key = `${dayAnchor ?? ""}|${hour ?? "?"}|${minute}|${ambiguous}`;
    if (seen.has(key)) continue;
    seen.add(key);

    refs.push({
      raw: raw.trim(),
      hour,
      minute,
      dayAnchor,
      ambiguous,
      viewerTimezone,
    });
  }

  return refs;
}

/**
 * Render a parsed reference as a human-readable "3:30pm" / "15:00" string
 * suitable for echoing back in the [GROUND TRUTH] block or a confirmation.
 * Returns null when the reference is ambiguous (no hour resolved).
 */
export function renderParsedTime(ref: ParsedTimeReference): string | null {
  if (ref.hour == null) return null;
  const h24 = ref.hour;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const meridiem = h24 < 12 ? "am" : "pm";
  const mm = ref.minute.toString().padStart(2, "0");
  return ref.minute === 0 ? `${h12}${meridiem}` : `${h12}:${mm}${meridiem}`;
}
