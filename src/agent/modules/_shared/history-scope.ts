/**
 * Conversation-history scope detector (proposal 2026-05-05_conversation-history-scope).
 *
 * A pure, deterministic classifier that decides whether a turn is a
 * `continue` (preserve full lookback) or a `pivot` (drop closed-task rows
 * from the lookback). The detector is the only place history-scoping
 * decisions are made (proposed Rule 28).
 *
 * Signals (proposal §2.2 + reviewer §5):
 *   1. Fresh-name: current turn names a proper-noun-shaped token NOT in the
 *      prior K=10-turn window AND prior turn is a closed-task narration.
 *   2. Closed-task / nameless-pivot: current turn names no proper noun AND
 *      prior turn is a closed-task narration AND current turn does not
 *      textually carry forward any of the prior turn's proper nouns AND
 *      current turn shows a structural pivot cue (contact-introducer or
 *      new-topic imperative).
 *   3. Anaphora: pronouns or determinative phrases ("it", "that",
 *      "the meeting", "the link") force `continue` UNLESS Signal 1 OR
 *      Signal 2 also fires (then the pronoun likely refers FORWARD to the
 *      pivot target, not back to history) — reviewer §5 case adjustment.
 *   4. Additive-connective: "and also", "plus", "as well", "also book"
 *      suppress `pivot` regardless of fresh-name — host is extending,
 *      not pivoting. Strongest continuation signal.
 *
 * K=10 matches DEFAULT_HISTORY_LIMIT so the detector and the model agree
 * on what counts as "in context".
 *
 * The runner does not pass action metadata to this pure function (proposal
 * §4.1 keeps the signature flat); the closed-task condition is approximated
 * by recognizing completion-narration patterns (Booked/Sent/Updated/...) in
 * the most recent assistant turn.
 *
 * Pure function: deterministic, no I/O, no LLM calls. Test seam.
 */

export type HistoryScopeMode = "continue" | "pivot";

export interface HistoryMessage {
  role: string;
  content: string;
}

export interface HistoryScopeResult {
  /** Pruned conversation history to pass to the composer. */
  messages: HistoryMessage[];
  /** Classification for telemetry + downstream behavior. */
  mode: HistoryScopeMode;
  /** Number of rows dropped relative to the input. */
  prunedCount: number;
  /** Names/topic tokens identified as belonging to closed tasks. */
  closedTasks: string[];
}

/** Lookback window for the fresh-name signal. Matches DEFAULT_HISTORY_LIMIT
 *  so the detector and the model agree on what counts as "in context". */
export const HISTORY_SCOPE_K = 10;

// ─── Signal-3 sources ───────────────────────────────────────────────────────

const ANAPHORA_TOKENS = new Set([
  "it", "that", "this", "him", "her", "them", "they",
  "he", "she", "his", "hers", "their", "its",
]);

const ANAPHORA_PHRASES = [
  "the meeting",
  "the call",
  "the link",
  "the event",
  "the invite",
  "the booking",
  "the appointment",
  "the rule",
  "the buffer",
  "the time",
  "the slot",
];

// ─── Signal-4 sources ───────────────────────────────────────────────────────

const ADDITIVE_PHRASES = [
  "and also",
  "and one with",
  "and one for",
  "plus also",
  "plus book",
  "plus one",
  "as well",
  "also book",
  "also one with",
  "also invite",
  "also schedule",
  "also create",
  "also set",
  "also do",
];

// ─── Sentence-initial filter for proper-noun extraction ─────────────────────

const COMMON_SENTENCE_INITIAL = new Set([
  "i", "the", "a", "an",
  "set", "block", "make", "schedule", "book", "create", "invite", "send",
  "add", "remove", "delete", "update", "change", "move", "shift", "cancel",
  "reschedule", "find", "get", "give", "tell", "show", "let", "please",
  "actually", "yes", "no", "ok", "okay", "sure", "thanks", "hi", "hello", "hey",
  "do", "does", "did", "will", "would", "can", "could", "should",
  "and", "but", "or", "if", "when", "while",
  "for", "to", "with", "from", "on", "in", "at", "by", "of",
  "my", "your", "our", "his", "her", "their",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july",
  "august", "september", "october", "november", "december",
  "am", "pm", "tomorrow", "today", "tonight", "yesterday",
  "next", "last", "this", "that",
  "tutoring", "lunch", "dinner", "breakfast", "coffee",
  "want",
]);

// ─── Closed-task narration detection ────────────────────────────────────────

const COMPLETION_VERB_TOKENS = new Set([
  "booked",
  "sent",
  "created",
  "made",
  "set",
  "updated",
  "cancelled",
  "canceled",
  "blocked",
  "protected",
  "done",
  "added",
  "removed",
  "deleted",
  "scheduled",
  "rescheduled",
  "moved",
  "shifted",
  "saved",
  "noted",
  "invited",
  "tutoring", // Report 10: "Tutoring link is updated to 1-hour sessions."
]);

// ─── Structural pivot-intent cues (Signal-2 gating) ─────────────────────────

// Contact-introducer verbs require a non-pronoun direct object: "invite him"
// is iteration ("him" = prior contact), but "invite katie" is a pivot. The
// negative lookahead suppresses pivot when the host is using anaphora to
// reuse a prior contact.
const PIVOT_INTENT_CUES: RegExp[] = [
  /\binvite\s+(?!him\b|her\b|them\b|me\b|us\b|you\b)[a-z]/,
  /\bbook\s+(?!him\b|her\b|them\b|it\b|me\b)[a-z]/,
  /\bschedule\s+(?!him\b|her\b|them\b|it\b|me\b)[a-z]/,
  /\bget time with\b/,
  /\bset up (a |the )?call with\b/,
  /\bcall with\b/,
  /\bmeeting with\b/,
  /\bset (a |the )?buffer\b/,
  /\bset .+ to \d+ (min|minute|minutes|hour|hours)\b/,
  /\bblock(ed)? (off |out )?(next |this |last )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|tomorrow|today|all day)\b/,
  /\bprotect (next |this |last )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|all day|morning|afternoon|evening)\b/,
  /\blimit\b.*\bto\b/,
  /\bcreate (a |the )?bookable\b/,
  /\bcreate (a |the )?link\b/,
  /\badd (a |the )?(rule|buffer|block)\b/,
];

export function looksLikePivotIntent(message: string): boolean {
  const lower = message.toLowerCase();
  for (const re of PIVOT_INTENT_CUES) {
    if (re.test(lower)) return true;
  }
  return false;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasWord(haystackLower: string, word: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(word)}([^a-z0-9]|$)`, "i");
  return re.test(haystackLower);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasAnaphora(message: string): boolean {
  const lower = message.toLowerCase();
  for (const phrase of ANAPHORA_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  const tokens = lower.split(/[^a-z']+/).filter(Boolean);
  for (const t of tokens) {
    if (ANAPHORA_TOKENS.has(t)) return true;
  }
  return false;
}

export function hasAdditiveConnective(message: string): boolean {
  const lower = message.toLowerCase();
  for (const phrase of ADDITIVE_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

export function extractProperNouns(message: string): string[] {
  const out: string[] = [];
  const raw = message.split(/\s+/);
  for (const tok of raw) {
    const cleaned = tok.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (cleaned.length < 2) continue;
    const first = cleaned[0]!;
    if (first < "A" || first > "Z") continue;
    const lower = cleaned.toLowerCase();
    if (COMMON_SENTENCE_INITIAL.has(lower)) continue;
    out.push(cleaned);
  }
  return Array.from(new Set(out));
}

export function nameAppearsInHistory(
  name: string,
  history: HistoryMessage[],
): boolean {
  const lower = name.toLowerCase();
  for (const msg of history) {
    if (typeof msg.content !== "string") continue;
    if (hasWord(msg.content.toLowerCase(), lower)) return true;
  }
  return false;
}

export function isClosedTaskNarration(content: string): boolean {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("?")) return false;
  const firstSentence = trimmed.split(/[.!\n]/)[0]!.toLowerCase();
  const tokens = firstSentence.split(/[^a-z]+/).filter(Boolean);
  for (const t of tokens) {
    if (COMPLETION_VERB_TOKENS.has(t)) return true;
  }
  return false;
}

// ─── Detector ───────────────────────────────────────────────────────────────

export function scopeHistory(
  history: HistoryMessage[],
  currentUserMessage: string,
): HistoryScopeResult {
  if (history.length === 0) {
    return { messages: history, mode: "continue", prunedCount: 0, closedTasks: [] };
  }

  const window = history.slice(-HISTORY_SCOPE_K);

  // Signal 4: additive-connective — strongest continuation signal.
  if (hasAdditiveConnective(currentUserMessage)) {
    return { messages: history, mode: "continue", prunedCount: 0, closedTasks: [] };
  }

  const currentNouns = extractProperNouns(currentUserMessage);

  // Last assistant/envoy turn — the closed-task evidence surface.
  const lastAssistant = [...window]
    .reverse()
    .find((m) => m.role === "assistant" || m.role === "envoy");
  const priorClosed = lastAssistant
    ? isClosedTaskNarration(lastAssistant.content || "")
    : false;
  const priorNounsLastTurn = lastAssistant
    ? extractProperNouns(lastAssistant.content || "")
    : [];

  // Signal 1: fresh-name. Only fires when prior turn is closed (leak surface
  // exists). Onboarding turns ("Alex" answering "what's your name?") have an
  // open clarifier prior turn → fresh-name does not fire → default `continue`.
  let pivotByFreshName = false;
  if (currentNouns.length > 0 && priorClosed) {
    const reReferences = currentNouns.some((n) => nameAppearsInHistory(n, window));
    if (!reReferences) pivotByFreshName = true;
  }

  // Signal 2 (nameless-pivot): closed-task narration prior + current turn
  // names no proper nouns + current turn does not carry forward any proper
  // noun from the prior turn AND current turn shows a structural pivot cue.
  // Reports 10 / 7. Also covers trigger-bundle lowercase-name turns
  // ("invite katie to lunch ...", "get time with paul").
  let pivotByClosedTask = false;
  if (currentNouns.length === 0 && priorClosed) {
    const carriesForward = priorNounsLastTurn.some((n) =>
      hasWord(currentUserMessage.toLowerCase(), n.toLowerCase()),
    );
    if (!carriesForward && looksLikePivotIntent(currentUserMessage)) {
      pivotByClosedTask = true;
    }
  }

  // Signal 3: anaphora — strong continuation signal. Overrides default but
  // yields to ANY pivot signal that already fired (in those cases the
  // pronoun refers FORWARD to the pivot target, not back to history).
  const isPivot = pivotByFreshName || pivotByClosedTask;
  if (!isPivot && hasAnaphora(currentUserMessage)) {
    return { messages: history, mode: "continue", prunedCount: 0, closedTasks: [] };
  }

  if (pivotByFreshName) {
    return {
      messages: [],
      mode: "pivot",
      prunedCount: history.length,
      closedTasks: collectHistoryProperNouns(window),
    };
  }

  if (pivotByClosedTask) {
    return {
      messages: [],
      mode: "pivot",
      prunedCount: history.length,
      closedTasks: priorNounsLastTurn,
    };
  }

  return { messages: history, mode: "continue", prunedCount: 0, closedTasks: [] };
}

function collectHistoryProperNouns(history: HistoryMessage[]): string[] {
  const set = new Set<string>();
  for (const msg of history) {
    if (typeof msg.content !== "string") continue;
    for (const n of extractProperNouns(msg.content)) set.add(n);
  }
  return Array.from(set);
}
