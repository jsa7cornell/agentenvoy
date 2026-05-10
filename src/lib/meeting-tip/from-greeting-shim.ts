// Phase 1 shim — PLUMBS the existing rendered greeting into the new tip slot.
// DELETED in Phase 2 when meeting-tip/render.ts replaces it.
// See proposal 2026-05-08 §3.1.
//
// Phase 2 entry condition: verify `from-greeting-shim.ts` and all imports
// of it are deleted — `git grep from-greeting-shim` must return no matches.
// Precedent: 960 LOC of dead code in greeting-template.ts (GREETINGS.md §11.C)
// shows what happens when shims aren't deleted. See proposal N5 resolution.

import type { Tip } from "@/components/MeetingCard/types";

/**
 * Maximum character length for a tip derived from a greeting.
 * Greetings can be verbose; the tip slot expects a short sentence.
 */
const MAX_TIP_CHARS = 280;

/**
 * Strips the leading greeting salutation from a rendered greeting string.
 *
 * Handles all known greeting prefix forms:
 *   "👋 Sarah! ..."       → "..."
 *   "👋 Sarah, ..."       → "..."
 *   "👋 Hi Sarah! ..."    → "..."
 *   "👋 ..."              → "..."  (anonymous — no name)
 *   "Hi Sarah! ..."       → "Hi Sarah! ..."  (no wave emoji — leave as-is)
 *
 * The wave emoji + name are already rendered by the info block's avatar/name
 * section; stripping them avoids redundant "Hi Sarah" text in the tip slot.
 */
function stripGreetingPrefix(text: string): string {
  // Match: optional wave emoji, optional "Hi ", optional name, optional
  // comma/exclamation, optional trailing whitespace — all at start of string.
  // The name is one or more non-punctuation words; stops at "," or "!" or " ".
  return text
    .replace(/^👋\s*(?:Hi\s+)?(?:[^,!\n]+)?[,!]\s*/u, "")
    .replace(/^👋\s*/u, "")
    .trim();
}

/**
 * Collapses multiple consecutive newlines (paragraph breaks) to a single newline.
 * Greeting strings sometimes include paragraph structure that reads poorly in
 * the compressed single-line tip slot.
 */
function collapseLineBreaks(text: string): string {
  return text.replace(/\n{2,}/g, "\n").trim();
}

/**
 * Truncates a string to `maxChars` characters, appending "…" if truncated.
 * Truncates at the last word boundary before the limit when possible.
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const truncated = lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut;
  return truncated.trimEnd() + "…";
}

/**
 * Converts a rendered greeting string into a `Tip` for the Phase 1 tip slot.
 *
 * - Strips leading "👋 [name]!" prefix (with or without comma).
 * - Collapses paragraph breaks to single newlines.
 * - Truncates to 280 characters with ellipsis.
 * - Returns `null` for empty / whitespace-only input.
 *
 * No `source` field — Phase 1 ships with no source label per B1 resolution.
 * Phase 2 adds `source` when the real tip generator ships.
 *
 * Idempotent: calling with an already-stripped string produces the same result.
 */
export function tipFromGreeting(greeting: string): Tip | null {
  if (!greeting || !greeting.trim()) return null;

  const stripped = stripGreetingPrefix(greeting);
  const collapsed = collapseLineBreaks(stripped);
  const truncated = truncate(collapsed, MAX_TIP_CHARS);

  if (!truncated) return null;

  return { text: truncated };
}
