/**
 * PII scrub utility for golden-set candidate extraction (Phase 4 PR 2).
 *
 * Pure utility, no I/O. Used by `extract.ts` to redact text before it
 * lands in the candidate JSONL. Style mirrors
 * `src/lib/feedback/redact-calendar.ts` — explicit, allowlist-shaped,
 * with the design rationale baked into this file comment so future
 * curators understand why each rule exists.
 *
 * What we scrub (pass order — email first, then names, then phones):
 *   - **Email addresses** → `<EMAIL_1>`, `<EMAIL_2>`, ... Stable
 *     per-call numbering. Conservative regex
 *     (`/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi`) to avoid eating
 *     surrounding punctuation. Email pass runs BEFORE the name pass so
 *     that `Sarah` in `sarah@chen.com` doesn't get replaced first and
 *     leave `<NAME_1>@chen.com` (no longer email-shaped) for the email
 *     pass to miss. After email pass, the standalone "Sarah" word in
 *     prose still gets caught by the name pass — both pieces of PII
 *     end up scrubbed independently.
 *   - **Known names** (case-insensitive, word-boundary). The caller
 *     supplies an allowlist via `ScrubContext.knownNames` — guest names
 *     from session.guestName + link.inviteeName/inviteeNames, and the
 *     host's user.name. Matched names are replaced with stable
 *     `<NAME_1>`, `<NAME_2>`, ... placeholders assigned in first-seen
 *     order per call. Re-occurrences within the same call reuse the
 *     same placeholder so curators can still tell who's who.
 *   - **Phone numbers** → `<PHONE>`. Single token (no numbering).
 *     Multiple phones in one scheduling turn are vanishingly rare, and
 *     numbering them would imply more semantic structure ("Mom's
 *     number vs Dad's") than scheduling dialog actually carries.
 *
 * What we DO NOT scrub:
 *   - **URLs.** The dialog frequently references deal-room links and
 *     calendar invite URLs as legitimate first-class content
 *     ("here's your room: https://agentenvoy.ai/meet/abc"). Stripping
 *     them would erase information the curator needs to judge whether
 *     a turn is on-rails. URLs are not high-PII either — slug-shaped
 *     IDs anonymize the host already; we accept the residual risk that
 *     a host has put a meaningful slug in their meet URL.
 *   - **Bare first-names not in `knownNames`.** False-positive risk is
 *     high: "Will you be there?", "Mark this on your calendar", "I
 *     have a Pat in mind" all contain capitalized words that are
 *     neither names nor would benefit from `<NAME_n>` substitution.
 *     Scheduling dialog has too many of these to safely scrub the
 *     long tail without an NER model. Allowlist-only is the
 *     defensible position for v1; if a leak is found in candidate
 *     review, John can extend the list per-session.
 *
 * Replacement is **single-pass per category** in the order above.
 * Email-first ordering is the load-bearing ordering: it lets a name
 * inside an email's local-part be captured as part of `<EMAIL_n>`
 * rather than be fragmented by the name pass into `<NAME_n>@host.tld`.
 * After email pass, the standalone-word name in surrounding prose is
 * still caught by the name pass.
 */

export interface ScrubContext {
  /**
   * Display names known to belong to this session — guest names from
   * session.guestName, link.inviteeName, link.inviteeNames[], and the
   * host's user.name. Replaced with deterministic placeholders.
   */
  knownNames: string[];
}

export interface ScrubResult {
  /** Scrubbed text. */
  text: string;
  /** Count of substitutions made. Sanity metric — surface in JSONL row
   *  so curators can spot turns that scrubbed unusually heavily. */
  replacements: number;
}

/** Conservative email regex: `\b` boundaries, allowed local-part chars
 *  `\w.+-`, domain dot-separated, TLD ≥ 2 ASCII letters. */
const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;

/** Phone candidate regex. Permissive on punctuation
 *  (spaces / dots / dashes), captures `+1` country code, optional
 *  `(area)`. We post-filter on digit count ≥ 10 to keep short numerics
 *  ("30 min", "page 5") from getting eaten.
 *
 *  Bracketing rules: leading anchor is "not preceded by word char" via
 *  lookbehind `(?<!\w)` so `+1` and `(415)` consume their leading
 *  punctuation. Trailing `\b` is enough on the right side because the
 *  match always ends in a digit (word char). A literal `\b` at the
 *  start would fail on `+1...` because `+` and `1` aren't a word
 *  boundary pair. */
const PHONE_CANDIDATE_RE =
  /(?<!\w)(\+?1[\s.\-]?)?(\(?\d{3}\)?[\s.\-]?)?\d{3}[\s.\-]?\d{4}\b/g;

/** Escape a literal string for use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count digits in a string — used to filter phone candidates. */
function digitCount(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") n++;
  }
  return n;
}

/**
 * Scrub PII from a single text string.
 *
 * Order matters: emails → names → phones. See file-level doc comment
 * for why email-first is load-bearing.
 */
export function scrubPII(text: string, ctx: ScrubContext): ScrubResult {
  if (!text) return { text: "", replacements: 0 };

  let out = text;
  let replacements = 0;

  // ---- Pass 1: emails ----
  // Run before names so a name embedded in an email local-part
  // (e.g. "sarah" in "sarah@chen.com") is consumed by `<EMAIL_n>`
  // rather than fragmented into `<NAME_n>@chen.com` (which would no
  // longer match the email regex).
  const emailToPlaceholder = new Map<string, string>();
  out = out.replace(EMAIL_RE, (match) => {
    replacements++;
    const key = match.toLowerCase();
    let placeholder = emailToPlaceholder.get(key);
    if (!placeholder) {
      placeholder = `<EMAIL_${emailToPlaceholder.size + 1}>`;
      emailToPlaceholder.set(key, placeholder);
    }
    return placeholder;
  });

  // ---- Pass 2: known names ----
  // Stable per-call numbering: same name → same placeholder.
  // Sort the allowlist by descending length so multi-word names
  // (`"Sarah Chen"`) match before their constituent words (`"Sarah"`)
  // when both are in the list — the long match wins, the short pass
  // runs second over already-substituted text.
  const nameToPlaceholder = new Map<string, string>();
  const namesByLength = [...ctx.knownNames]
    .filter((n) => n.trim().length > 0)
    .sort((a, b) => b.length - a.length);

  for (const name of namesByLength) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    // Word-boundary, case-insensitive. Whole-name match.
    const re = new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "gi");
    out = out.replace(re, () => {
      replacements++;
      let placeholder = nameToPlaceholder.get(trimmed.toLowerCase());
      if (!placeholder) {
        placeholder = `<NAME_${nameToPlaceholder.size + 1}>`;
        nameToPlaceholder.set(trimmed.toLowerCase(), placeholder);
      }
      return placeholder;
    });
  }

  // ---- Pass 3: phones ----
  // Single token, no numbering — see file-level comment.
  out = out.replace(PHONE_CANDIDATE_RE, (match) => {
    if (digitCount(match) < 10) return match;
    replacements++;
    return "<PHONE>";
  });

  return { text: out, replacements };
}
