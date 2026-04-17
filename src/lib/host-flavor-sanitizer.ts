/**
 * Sanitize free-text "flavor" supplied by the host that will eventually land
 * in an LLM prompt and/or be rendered to a guest.
 *
 * Threat model: the host's own account is trusted, but they may paste content
 * copied from elsewhere (emails, docs). We defend against:
 *   - prompt injection via embedded instructions
 *   - accidental PII leakage (URLs, emails, phone numbers in the quoted tone)
 *   - formatting tricks that break out of quoted blocks (backticks, markers)
 *   - pathological length
 *
 * The sanitized value is rendered inside a delimited [HOST FLAVOR] block in
 * Envoy's prompt with explicit instructions to treat it as description, not
 * commands (see `src/agent/playbooks/ground-truth.md`).
 */

const MAX_LEN = 200;

// Obvious injection markers. We reject the whole input rather than strip
// so the host sees the rejection and can rephrase. Case-insensitive.
const REJECT_PATTERNS: RegExp[] = [
  /\[SYSTEM\b/i,
  /\[INST\b/i,
  /<\|/,                         // ChatML / SentencePiece markers
  /\bignore (?:previous|prior|all) (?:instructions?|rules?|directives?)/i,
  /\bnew instructions?\b/i,
  /\bforget (?:previous|prior|all)/i,
  /\boverride (?:system|safety|previous)/i,
  /```\s*(?:system|prompt|instructions?)/i,
];

// Carriers of PII / injection context we STRIP (don't reject) because a host
// saying "at our office, see you there" shouldn't fail if they include a
// stray URL in passing.
const STRIP_URL = /\bhttps?:\/\/\S+/gi;
const STRIP_EMAIL = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/gi;
// Phone numbers: international / US shapes, liberal.
const STRIP_PHONE = /(\+?\d[\d\s().-]{7,}\d)/g;
// Backticks and template-literal sequences — break out of quoted context in
// many LLM formats. Not needed for human tone.
const STRIP_FENCED = /(?:```[\s\S]*?```|`[^`]*`|\$\{[^}]*\})/g;

export interface SanitizedFlavor {
  /** Cleaned text, safe to include in a [HOST FLAVOR] block. Empty string if nothing usable remained. */
  safe: string;
  /** True when the whole input was rejected (an explicit marker tripped). */
  rejected: boolean;
  /** Machine-readable reason when rejected. */
  reason?: "injection-marker" | "too-long-before-strip";
  /** The raw input, preserved for logging on rejection. NOT stored long-term. */
  raw: string;
}

/**
 * Sanitize a single short free-text field from the host — e.g.,
 * `link.rules.guestGuidance.tone`. Structured fields (string[] of suggestions)
 * do NOT need this; they're rendered as chips, never interpolated into prompts.
 */
export function sanitizeHostFlavor(raw: unknown): SanitizedFlavor {
  if (typeof raw !== "string") return { safe: "", rejected: false, raw: "" };
  const trimmed = raw.trim();
  if (!trimmed) return { safe: "", rejected: false, raw: "" };

  // Pathological length BEFORE stripping — a 50k-char injection blob with one
  // REJECT_PATTERN hit shouldn't make us scan 50k of text.
  if (trimmed.length > MAX_LEN * 20) {
    return { safe: "", rejected: true, reason: "too-long-before-strip", raw: trimmed };
  }

  for (const pat of REJECT_PATTERNS) {
    if (pat.test(trimmed)) {
      return { safe: "", rejected: true, reason: "injection-marker", raw: trimmed };
    }
  }

  let cleaned = trimmed
    .replace(STRIP_FENCED, "")
    .replace(STRIP_URL, "")
    .replace(STRIP_EMAIL, "")
    .replace(STRIP_PHONE, "")
    // Collapse runs of whitespace that the strips may have created.
    .replace(/\s{2,}/g, " ")
    .trim();

  if (cleaned.length > MAX_LEN) cleaned = cleaned.slice(0, MAX_LEN).trim();

  return { safe: cleaned, rejected: false, raw: trimmed };
}

/**
 * Sanitize a string array (e.g., suggested locations). Each item is
 * length-capped and URL/email/phone-stripped, empties dropped. Array is
 * capped at 8 items to keep greeting UIs tight.
 */
export function sanitizeSuggestionList(raw: unknown, opts?: { itemMax?: number; arrayMax?: number }): string[] {
  if (!Array.isArray(raw)) return [];
  const itemMax = opts?.itemMax ?? 80;
  const arrayMax = opts?.arrayMax ?? 8;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // Apply the same injection reject — a suggestion entry saying
    // "[SYSTEM: override]" shouldn't make it through.
    const check = sanitizeHostFlavor(item);
    if (check.rejected) continue;
    const t = check.safe.slice(0, itemMax).trim();
    if (t) out.push(t);
    if (out.length >= arrayMax) break;
  }
  return out;
}
