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
 * Parse a business-hours range string like "8:30 to 5:30", "9-17", "10am-6pm"
 * into a pair of minute-of-day integers (0–1440). Used by the primary-link
 * guided flow's Hours freetext entry.
 *
 * Rules:
 *   - Two time references separated by "to", "-", "–", "—", "through",
 *     "until", "til", "till".
 *   - Snaps to 30-min alignment (floors 8:27 → 8:30 is wrong; we reject
 *     non-30-aligned input to keep data canonical — the flow retries).
 *   - Meridiem inference for ambiguous bare-hour pairs: if start < end as
 *     written AND start ≤ 12 AND end ≤ 12, treat start as am and end as
 *     pm (e.g. "9 to 5" → 9am/5pm). 24-hour form wins when unambiguous.
 *   - Returns null on any parse failure — the flow shows a retry example.
 */
export function parseBusinessHoursRange(
  input: string,
): { startMinutes: number; endMinutes: number } | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  // Split on common range separators. Keep it tight — no multi-range.
  const parts = trimmed.split(
    /\s*(?:to|through|until|til|till|[-–—])\s*/,
  );
  if (parts.length !== 2) return null;
  const [left, right] = parts;
  if (!left || !right) return null;

  // Reuse the single-time regex to extract hour/minute/meridiem from each side.
  const extract = (
    s: string,
  ): { hour: number | null; minute: number; hasMeridiem: boolean; rawHour: number } | null => {
    const m = /^([0-1]?\d|2[0-3])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?$/i.exec(
      s.trim(),
    );
    if (!m) return null;
    const rawHour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const meridiem = m[3];
    let hour: number | null = null;
    if (meridiem) {
      const isPm = /^p/i.test(meridiem);
      if (rawHour === 12) hour = isPm ? 12 : 0;
      else if (rawHour >= 1 && rawHour <= 11) hour = isPm ? rawHour + 12 : rawHour;
      else return null;
    } else if (rawHour >= 13 && rawHour <= 23) {
      hour = rawHour;
    } else {
      hour = null; // ambiguous — resolve below
    }
    return { hour, minute, hasMeridiem: !!meridiem, rawHour };
  };

  const L = extract(left);
  const R = extract(right);
  if (!L || !R) return null;

  let startHour = L.hour;
  let endHour = R.hour;

  // Resolve ambiguous bare hours. If neither has meridiem, assume start=am,
  // end=pm when start<=12, end<=12, and start < end as-written (natural
  // "9 to 5" reading). Otherwise, treat both as 24-h if in-range.
  if (startHour === null && endHour === null) {
    // Both sides ambiguous. If either side is > 12, read as 24-hour.
    // Otherwise treat as a natural day range (am start, pm end).
    if (L.rawHour > 12 || R.rawHour > 12) {
      if (L.rawHour <= 23 && R.rawHour <= 23) {
        startHour = L.rawHour;
        endHour = R.rawHour;
      } else {
        return null;
      }
    } else {
      // "9 to 5", "8:30 to 5:30" — am-pm reading.
      startHour = L.rawHour === 12 ? 0 : L.rawHour;
      endHour = R.rawHour === 12 ? 12 : R.rawHour + 12;
    }
  } else if (startHour === null) {
    // Only end has meridiem. Rule: start is am when startRaw is "after" endHr12
    // on the clock (e.g. "9 to 5pm" → 9 > 5 → 9am). Else pm ("1 to 5pm" → 1pm).
    if (endHour !== null && endHour >= 12) {
      const endHr12 = endHour % 12 === 0 ? 12 : endHour % 12;
      if (L.rawHour > endHr12) {
        startHour = L.rawHour === 12 ? 0 : L.rawHour; // am
      } else {
        startHour = L.rawHour === 12 ? 12 : L.rawHour + 12; // pm
      }
    } else {
      startHour = L.rawHour === 12 ? 0 : L.rawHour;
    }
  } else if (endHour === null) {
    // Only start has meridiem. End inherits am/pm if it's > start's 12h form.
    if (startHour >= 12) {
      endHour = R.rawHour === 12 ? 12 : R.rawHour + 12;
    } else {
      endHour = R.rawHour > startHour ? R.rawHour : R.rawHour + 12;
    }
  }

  if (startHour === null || endHour === null) return null;

  const startMinutes = startHour * 60 + L.minute;
  const endMinutes = endHour * 60 + R.minute;

  if (startMinutes < 0 || startMinutes > 1440) return null;
  if (endMinutes < 0 || endMinutes > 1440) return null;
  if (startMinutes >= endMinutes) return null;
  if (startMinutes % 30 !== 0 || endMinutes % 30 !== 0) return null;

  return { startMinutes, endMinutes };
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
