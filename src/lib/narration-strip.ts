/**
 * Narration-strip utilities — shared between server (post-stream-checks) and
 * client (deal-room streaming renderer).
 *
 * The server runs `stripThinkingOutLoudSentences` post-stream so the persisted
 * message is clean. The client runs it on every streamed chunk so the guest
 * never sees the narration text — not even for the 200–500ms window between
 * stream-end and the server's final clean frame arriving.
 *
 * Keeping this in lib/ (not agent/unified/) makes it importable from both
 * server-only modules and Next.js client components without a barrel issue.
 *
 * 2026-05-15 — extracted from post-stream-checks.ts (cmp662dbn narration-flash
 * fix). Both callers import from here; the patterns live in exactly one place.
 */

/**
 * Patterns that identify "thinking out loud" sentences — phrases the model
 * emits when narrating its own reasoning rather than speaking to the user.
 * Each entry is a production-observed shape with a comment citing the incident.
 */
export const THINKING_OUT_LOUD_PATTERNS: readonly RegExp[] = [
  /\bNow I[''']ll\b/i,                     // "Now I'll load the calendar..."
  // 2026-05-14 cmp50uvuq: "Now I (can|see|have|know) ..." — the model
  // narrates what it just learned from a LOAD before acting. Same shape as
  // "Now I'll", different verb structure. Production case: "Now I can see
  // tomorrow's date is May 8, 2026" — leak that survived prior patterns.
  /\bNow I (?:can(?:\s+see)?|see|have|know|understand)\b/i,
  // "I (can|now) see <X>" — inverted form of the same shape.
  /\bI (?:can|now) see\s+(?:that|what|why|how|the|your|tomorrow|today)/i,
  // "Let me <verb>" — NOT "Let me know" (canonical template close).
  // 2026-05-14 cmp4ss1ip widening: added the write-action verbs (reschedule,
  // cancel, move, create, book, set up, archive, release, free, update the
  // <thing>) — Haiku narrates "Let me reschedule this meeting" as a preamble
  // before the actual tool call on deal-room reschedule turns. Same shape as
  // the original "Let me check/load" pre-action narration.
  /\bLet me (?:check|load|look|update|verify|fetch|see|think|review|reconsider|update the|check the|load the|look at|see if|think about|reschedule|cancel|move|create|book|set up|archive|release|free|find|grab|adjust)\b/i,
  /\bI[''']ll (?:load|check|look|update|update the|create the|fetch)\b/i,
  // "I need to load/check/..." — the LOAD-narration variant that doesn't use
  // "I'll" (2026-05-13 rnmp4f incident). "Now I need to load..." is the same
  // shape with a leading "Now".
  /\b(?:Now\s+)?I need to (?:load|check|look|update|verify|fetch|see|review|reconsider)\b/i,
  // 2026-05-14 cmp4ss1ip: date-announcement preamble. The model narrates
  // "Today/Tomorrow is <Date>" before acting on a temporal reference. Pure
  // reasoning out loud — the user doesn't need the model to recite the date
  // back at them. Production-observed shape: "Tomorrow is **May 14, 2026
  // (Thursday)**. Let me reschedule this meeting."
  /\b(?:Today|Tomorrow|Yesterday) is\s+\*{0,2}[A-Z][a-z]+/,
  /\bHowever,?\s+looking more carefully\b/i, // The cmp2qcnjy smoking gun
  /\bOn review\b/i,                         // From the old remediation prompt
  /\bLooking (?:more carefully|at this again)\b/i,
  // "Looking at your calendar" / "Looking at the preferences" — narrating
  // the model's own context-read (2026-05-13 rnmp4f).
  /\bLooking at (?:your|the) (?:calendar|preferences|sessions|schedule|availability|link|rules)\b/i,
  /\bThinking about this\b/i,
  /\bThe user (?:specified|said|wants|is asking)\b/i,  // Narrating the model's parse of the user
  /\bBased on the (?:calendar|preferences|sessions)\b/i,
  /\bSince (?:the user|you) (?:specified|said|mentioned)\b/i,
];

/**
 * Does the prose contain a known "thinking out loud" phrase?
 */
export function hasThinkingOutLoudPhrase(text: string): boolean {
  if (!text) return false;
  for (const rx of THINKING_OUT_LOUD_PATTERNS) {
    if (rx.test(text)) return true;
  }
  return false;
}

/**
 * Strip "thinking out loud" sentences from prose. Splits on sentence
 * boundaries (`.`, `!`, `?`, newline) and drops any sentence containing a
 * forbidden phrase. Returns the remainder trimmed. If everything was
 * forbidden (the model leaked top-to-bottom), returns an empty string —
 * the caller decides on a fallback (typically the canonical close template).
 *
 * Safe to call mid-stream: an incomplete trailing sentence (no terminator)
 * is kept as-is because the splitter only fires on `.!?\n`. Once the
 * sentence completes on the next chunk, the pattern will fire if it matches.
 *
 * Deterministic, no model call.
 */
export function stripThinkingOutLoudSentences(text: string): string {
  if (!text) return "";
  // Split on sentence terminators while keeping the terminator. Newline
  // is treated as a soft boundary so multi-paragraph leaks split cleanly.
  const pieces = text
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const kept = pieces.filter((s) => !hasThinkingOutLoudPhrase(s));
  return kept.join(" ").trim();
}
