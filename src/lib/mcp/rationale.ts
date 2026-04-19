/**
 * Rationale prose: prompt constraints, post-generation validator, template
 * render.
 *
 * SPEC §3.
 *
 * The LLM generates a short prose justification for each proposed change.
 * It is shown LIVE in the deal-room (never logged — call-log.ts drops the
 * `rationaleProse` field at log-write). To keep the LIVE surface safe:
 *
 *   1. The prompt instructs the model to stay within `{{placeholder}}`
 *      tokens drawn only from RATIONALE_PLACEHOLDERS (§3.1).
 *   2. A post-generation runtime validator (§3.4) rejects any output that
 *      contains URLs, emails, phone numbers, or exceeds 200 chars.
 *   3. On validator trip, the UI falls back to the TEMPLATE render —
 *      `interpolate(template, context)` — which is structurally safe
 *      because the template and placeholder set are controlled by us.
 *
 * The validator is allowed to be conservative (false-positive-lean): a
 * tripped validator just means the UI falls back to the template render.
 * Sentry gets a fingerprinted breadcrumb so we can tune the regex.
 */

import {
  RATIONALE_PLACEHOLDERS,
  RATIONALE_PLACEHOLDER_SET,
  type RationalePlaceholder,
} from "./placeholders";

// ---------------------------------------------------------------------------
// Prompt constraints
// ---------------------------------------------------------------------------

/**
 * Slot into the Host-Envoy system prompt when it is asked to produce a
 * rationale. The `{{placeholders}}` are literal — the Host-Envoy is told
 * what the allow-list is so refusal-reasons can be authored in-band.
 */
export const RATIONALE_PROMPT_CONSTRAINTS = `
When producing a rationale for a proposed change, obey these rules:
- One sentence. Max 200 characters.
- No URLs, no email addresses, no phone numbers.
- You may reference these fields by name: ${RATIONALE_PLACEHOLDERS.join(", ")}.
- Do not invent new placeholders. Do not paste verbatim guest data.
`.trim();

// ---------------------------------------------------------------------------
// Post-generation validator
// ---------------------------------------------------------------------------

// Conservative regexes. Tuned to catch the common shapes; false-positives
// trigger a template fallback which is a strictly-safer surface.
const URL_REGEX = /\b(?:https?:\/\/|www\.)\S+|\b[\w.-]+\.(?:com|net|org|io|co|dev|ai|app)\b/i;
const EMAIL_REGEX = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// Phone: 7+ digits with optional separators, or a leading +country code.
const PHONE_REGEX = /(?:\+\d[\d\s().-]{6,})|(?:\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b)/;

export const RATIONALE_MAX_LEN = 200;

export type RationaleValidationResult =
  | { ok: true }
  | {
      ok: false;
      /** One of the four trip categories, for telemetry fingerprinting. */
      reason: "url" | "email" | "phone" | "length";
    };

/**
 * Run the live-surface validator. Returns `{ ok: true }` iff the prose is
 * safe to show as-is. Otherwise the caller must fall back to the template
 * render and emit the Sentry breadcrumb
 * `["rationale_prose_validator_tripped", field, reason]`.
 */
export function validateRationaleProse(prose: string): RationaleValidationResult {
  if (prose.length > RATIONALE_MAX_LEN) return { ok: false, reason: "length" };
  // Check email before URL — "alex@example.com" matches both, and the more
  // specific classification is the useful one for telemetry.
  if (EMAIL_REGEX.test(prose)) return { ok: false, reason: "email" };
  if (URL_REGEX.test(prose)) return { ok: false, reason: "url" };
  if (PHONE_REGEX.test(prose)) return { ok: false, reason: "phone" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Template render
// ---------------------------------------------------------------------------

export type RationaleContext = Partial<Record<RationalePlaceholder, string>>;

/**
 * Render a `{{placeholder}}` template against the typed context. Any token
 * not in RATIONALE_PLACEHOLDER_SET is left unrendered and reported to the
 * caller via the returned `unknownPlaceholders` array — callers should
 * treat a non-empty array as a bug (template authored with a placeholder
 * outside the allow-list).
 *
 * Missing context values render as the placeholder name in brackets
 * (e.g., `[format]`) so the output is never a dangling `{{format}}` that
 * slips into the UI.
 */
export function renderRationaleTemplate(
  template: string,
  context: RationaleContext,
): { output: string; unknownPlaceholders: string[] } {
  const unknown: string[] = [];
  const output = template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_match, raw: string) => {
    if (!RATIONALE_PLACEHOLDER_SET.has(raw)) {
      unknown.push(raw);
      return `{{${raw}}}`;
    }
    const value = context[raw as RationalePlaceholder];
    return value ?? `[${raw}]`;
  });
  return { output, unknownPlaceholders: unknown };
}
