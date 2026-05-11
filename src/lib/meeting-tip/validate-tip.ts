/**
 * Synchronous tip validation gate — Phase 2 PR4 (2026-05-11).
 *
 * Pure function: no I/O, no side effects. Called in `handleCreateLink`
 * before writing `link.parameters.tip`. If the LLM-emitted tip passes all
 * checks, the caller writes it; otherwise the caller falls back to
 * DEFAULT_TIP.
 *
 * Rules per proposal 2026-05-11_llm-tip-seed-at-create-link.md §5:
 *  - No date word  (Mon, Tuesday, Jan, March, …)
 *  - No time string  (3pm, 10:30 AM, …)
 *  - No format word  (zoom, google meet, phone, video, in-person)
 *  - No literal location substring (case-insensitive match against link's
 *    location parameter, if set)
 *  - Must be ≤ 200 chars after trim
 *  - Must not be empty / whitespace-only
 */

const DATE_WORD_RE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*/i;
const TIME_STRING_RE = /\b\d{1,2}:?\d{0,2}\s*(am|pm)\b/i;
const FORMAT_WORD_RE = /\b(zoom|google meet|phone|video|in-person)\b/i;

const MAX_CHARS = 200;

export interface TipValidationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Validate a candidate tip string before persisting it.
 *
 * @param text     The tip string emitted by the LLM (may be undefined).
 * @param location The link's location parameter (may be null/undefined).
 *                 Used for the literal-location-substring check.
 * @returns        `{ valid: true, reasons: [] }` on pass;
 *                 `{ valid: false, reasons: [...] }` listing why it failed.
 */
export function validateTip(
  text: string | undefined,
  location: string | null | undefined,
): TipValidationResult {
  const reasons: string[] = [];

  // Empty / missing
  if (!text || text.trim().length === 0) {
    return { valid: false, reasons: ["empty"] };
  }

  const trimmed = text.trim();

  // Length gate
  if (trimmed.length > MAX_CHARS) {
    reasons.push(`too_long:${trimmed.length}`);
  }

  // Date word
  if (DATE_WORD_RE.test(trimmed)) {
    reasons.push("forbidden_pattern:date");
  }

  // Time string
  if (TIME_STRING_RE.test(trimmed)) {
    reasons.push("forbidden_pattern:time");
  }

  // Format word
  if (FORMAT_WORD_RE.test(trimmed)) {
    reasons.push("forbidden_pattern:format");
  }

  // Literal location substring (case-insensitive)
  if (location && location.trim().length > 0) {
    if (trimmed.toLowerCase().includes(location.trim().toLowerCase())) {
      reasons.push("forbidden_pattern:literal_location");
    }
  }

  return { valid: reasons.length === 0, reasons };
}
