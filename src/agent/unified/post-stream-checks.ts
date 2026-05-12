/**
 * Post-stream defense module (Phase A.5 + B3-c convergence with the
 * 2026-05-12 cost-reduction proposal's success-theater check).
 *
 * Two regex-based deterministic checks that run AFTER the stream completes,
 * sharing one architectural slot:
 *
 *   1. `narrationWithoutEmitCheck` (A.5) — fires when the model produces
 *      confirmation-shaped prose ("Wednesday afternoon is now blocked.")
 *      but called ZERO tools. This is the cmp1nni72 failure shape ported
 *      from the legacy `negotiate/message/route.ts:415-420`
 *      `NARRATION_WITHOUT_EMIT` regex, REWIRED per Round 2 RP1: the legacy
 *      regex gated on `actions.length === 0` (counted parsed `[ACTION]`
 *      blocks); under UA there are no `[ACTION]` blocks, so the equivalent
 *      gate is `toolCalls.length === 0`.
 *
 *   2. `successTheaterCheck` (cost-reduction Phase 1.5 E) — fires when the
 *      model produced the same confirmation-shaped prose but at least one
 *      tool call returned `success: false`. The model claims a write
 *      succeeded; the tool result says it didn't. Three shapes per the
 *      cost-reduction proposal's §1.3:
 *        - shape-1 (subsumed by `narrationWithoutEmitCheck`): no tool called
 *        - shape-2: tool called, returned success but the tool isn't a write
 *        - shape-3: tool called, returned success:false, prose lies anyway
 *      Shape-3 is the most-important per the cost-reduction reviewer's B1
 *      finding (the original regex missed it).
 *
 * Both checks are SEV-WARN log-only in v1. They write to
 * `metadata.unifiedTurn.postStreamGuards = [{name, scope, fired: true}]`
 * so we can measure rates over a 7-day window before deciding whether to
 * escalate to text-replacement or remediation rerun (per the cost-reduction
 * proposal's Phase 1.5 → Phase 2 telemetry gate).
 *
 * The runner is the ONLY place these are invoked (Phase A.4 wiring will
 * land in runUnifiedTurn's post-stream phase). Listed here:
 *   - DEFAULT_POST_STREAM_CHECKS — the array a default runner caller uses.
 *   - Individual exports for tests + bespoke callers.
 *
 * Refs:
 *   - proposals/2026-05-11_complete-unified-agent-migration-and-retire-classifier-composer_reviewed-2026-05-11_decided-2026-05-11.md §2.5 Phase A.5 + RP1
 *   - proposals/2026-05-12_unified-agent-cost-recency-thinking-load-and-theater-defense_reviewed-2026-05-12.md §1.3 + Phase 1.5 (E)
 *   - The decision to converge them into one module instead of shipping two
 *     parallel post-stream guards is B3-c of the 2026-05-12 reviewer's
 *     fresh-eyes pass + the same convergence John's 2026-05-12 message
 *     directed when the cost-reduction (E) was parked.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-tool-call record passed to each check. The runner constructs this
 * from `result.steps[].toolCalls` + `result.steps[].toolResults` after the
 * stream finishes.
 *
 * `success` is the boolean from the tool's `ActionResult.success` when the
 * tool returned an `ActionResult`-shaped output; `undefined` for tools that
 * don't conform (LOAD_* tools return their data directly without a success
 * flag — they aren't writes, so theater-check doesn't apply).
 */
export type PostStreamToolCall = {
  toolName: string;
  success: boolean | undefined;
};

export type PostStreamCheckInput = {
  /** The model's full text response (after streaming, before persistence). */
  fullText: string;
  /** Tool calls made during this turn, paired with their success flags. */
  toolCalls: readonly PostStreamToolCall[];
};

export type PostStreamCheckResult = {
  fired: boolean;
  /** Which sub-shape inside this check fired. */
  scope?: string;
  /** Free-text reason for telemetry. */
  reason?: string;
};

export type PostStreamCheck = {
  name: string;
  check: (input: PostStreamCheckInput) => PostStreamCheckResult;
};

// ---------------------------------------------------------------------------
// Shared confirmation-shaped-prose regex
// ---------------------------------------------------------------------------

/**
 * Regex catching prose that CLAIMS a write effect happened — verb-shaped,
 * not noun-shaped, so read-only sentences ("Your timezone IS America/...")
 * don't trip the gate.
 *
 * Production-observed shapes from COMPOSER.md §2 F-rows + the cmp1nni72
 * triage + the cost-reduction case study + the 2026-05-12 deal-room cancel
 * incident:
 *   - "Wednesday afternoon is now blocked" (cmp1nni72)
 *   - "Friday May 8 is now fully protected"
 *   - "Got it — updated location to Konditori" (dealroom past-tense template)
 *   - "Got it — cancelling this meeting now" (2026-05-12 cancel incident —
 *     present-progressive, NOT past tense; v1 of the regex missed this)
 *   - "Done — moved it to Thursday 3pm"
 *   - "Booked Friday 2pm" / "Cancelled" / "Created the link"
 *   - "I've blocked Friday" / "I've rescheduled it"
 *   - "I'll cancel that now" (future-intent that implies imminent action)
 *
 * Past tense ("cancelled"), present progressive ("cancelling"), and
 * future-intent ("will cancel" / "I'll cancel") all map to the same
 * failure mode: prose claims an action is happening/done, no tool call
 * fired. The 2026-05-12 incident showed the v1 regex was too tight —
 * widened here to cover all three tenses for write-effect verbs.
 */
const CONFIRMATION_PROSE_PATTERNS: readonly RegExp[] = [
  // "X is now (fully) blocked/protected/locked/updated/created/cancelled/..."
  /\b(?:is|are)\s+now\s+(?:fully\s+)?(?:blocked|protected|locked|updated|created|cancell?ed|archived|rescheduled|set\s+up|in\s+place|booked|live)\b/i,
  // "now fully blocked/protected/locked/updated/in place" (no leading "is")
  /\bnow\s+fully\s+(?:blocked|protected|locked|updated|in\s+place)\b/i,
  // "I've / I have (just) blocked/protected/locked/cancelled/archived/rescheduled/booked X"
  /\bI(?:['’]?ve|\s+have)\s+(?:just\s+)?(?:blocked|protected|locked|cancell?ed|archived|rescheduled|booked|created|sent)\b/i,
  // Deal-room canonical confirmation templates — past-tense lead clause
  /\bGot\s+it\s+—\s+(?:updated|switched|moved|saved|cancell?ed|changed)\b/i,
  /\bDone\s+—\s+(?:moved|switched|saved|updated|booked|cancell?ed)\b/i,
  // Deal-room PRESENT-PROGRESSIVE templates (2026-05-12 incident widening):
  // "Got it — cancelling this meeting now" / "Got it — moving it" / "Done — booking now"
  // The "-ing now" combo + a "Got it — " or "Done — " lead is the prose signature.
  /\bGot\s+it\s+—\s+(?:cancell?ing|moving|switching|updating|saving|changing|booking)\b/i,
  /\bDone\s+—\s+(?:cancell?ing|moving|switching|updating|saving|booking)\b/i,
  // "I'll cancel/move/update/book/save/change that now" — future intent that
  // implies the model is about to act. If the tool call doesn't follow, it's
  // theater.
  /\bI['’]ll\s+(?:cancel|move|update|book|save|change|reschedule)\b.*?\b(?:now|right\s+(?:now|away))\b/i,
  // "I'm cancelling/moving/updating now" — present progressive without "Got it"
  /\bI['’]?m\s+(?:cancell?ing|moving|updating|booking|saving|rescheduling)\b/i,
  // "cancelling this meeting now" — bare present-progressive with "now"
  // anchor. Matches even when the model omits the "Got it — " preamble.
  /\b(?:cancell?ing|moving|updating|booking|rescheduling)\b[^.!?]*\bnow\b/i,
  // "Booked X" / "Cancelled X" / "Created X" / "Saved X" at the start of a sentence
  /(?:^|[.!?]\s+)(?:Booked|Cancell?ed|Created|Saved|Sent)\s+\w+/m,
];

/**
 * Does the prose look like a confirmation-template write claim?
 * Pure: text-only, no side effects.
 */
export function isConfirmationShapedProse(text: string): boolean {
  if (!text) return false;
  for (const rx of CONFIRMATION_PROSE_PATTERNS) {
    if (rx.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Check 1 — narrationWithoutEmitCheck (A.5 / cmp1nni72)
// ---------------------------------------------------------------------------

/**
 * Fires when the model produced confirmation-shaped prose BUT called zero
 * tools. The model claimed a write happened; no tool ran. This is the
 * cmp1nni72 shape — "Wednesday afternoon is now blocked" with no
 * `rule_add` invocation.
 *
 * Rewired per Round 2 RP1: legacy regex used `actions.length === 0`
 * (counting parsed `[ACTION]` blocks); UA equivalent is
 * `toolCalls.length === 0`.
 */
export const narrationWithoutEmitCheck: PostStreamCheck = {
  name: "narration-without-emit",
  check: ({ fullText, toolCalls }) => {
    if (toolCalls.length > 0) return { fired: false };
    if (!isConfirmationShapedProse(fullText)) return { fired: false };
    return {
      fired: true,
      scope: "shape-1",
      reason: "Prose claims a write effect happened but no tool was called.",
    };
  },
};

// ---------------------------------------------------------------------------
// Check 2 — successTheaterCheck (cost-reduction Phase 1.5 E)
// ---------------------------------------------------------------------------

/**
 * Fires when the model produced confirmation-shaped prose AND at least one
 * tool call returned `success: false`. The model is reporting success while
 * the tool reported failure.
 *
 * Scope codes (per cost-reduction proposal §1.3, after the reviewer's B1
 * expansion):
 *   - "shape-3" — tool returned success: false, prose lies anyway (the
 *     case the original cost-reduction draft missed, expanded per B1).
 *   - "shape-2" — reserved for "tool called and succeeded but the tool
 *     isn't actually a write" (LOAD_* tools, etc.). Not implemented in v1
 *     because LOAD-only turns are rare on write-confirmation-shaped prose;
 *     re-evaluate after telemetry.
 *
 * Shape-1 ("no tool called, prose lies") is owned by narrationWithoutEmitCheck
 * above. The two checks partition the failure space: shape-1 if toolCalls.length
 * === 0; shape-3 if toolCalls.length > 0 AND any success: false.
 */
export const successTheaterCheck: PostStreamCheck = {
  name: "success-theater",
  check: ({ fullText, toolCalls }) => {
    if (toolCalls.length === 0) return { fired: false }; // shape-1 owned elsewhere
    const anyFailed = toolCalls.some((tc) => tc.success === false);
    if (!anyFailed) return { fired: false };
    if (!isConfirmationShapedProse(fullText)) return { fired: false };
    const failedNames = toolCalls
      .filter((tc) => tc.success === false)
      .map((tc) => tc.toolName)
      .join(", ");
    return {
      fired: true,
      scope: "shape-3",
      reason: `Prose claims a write effect happened but tool(s) returned success: false: ${failedNames}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Check 3 — narrationLeakCheck (cost-reduction 2026-05-12 follow-up)
// ---------------------------------------------------------------------------

/**
 * Fires when the model produced confirmation-shaped prose AND a successful
 * write, BUT the prose is structurally too long OR contains "thinking out
 * loud" phrases that the system prompt explicitly forbids.
 *
 * Background (cmp2qcnjy0011s5n70linsdkx, 2026-05-12): a Haiku turn emitted
 * a correct `personal_link_create` but wrote a 1,126-character multi-
 * paragraph response with phrases like "Now I'll load the calendar...",
 * "However, looking more carefully...", "Let me update the link...".
 * That violates STEP 2 OUTPUT RULE in the unified-agent prompt
 * ("Stay silent before the tool calls. Output exactly the one template
 * sentence below — and stop."), but prompt rules don't bind 100%.
 * This is the structural backstop.
 *
 * γ-default (flag-only) per the cost-reduction proposal's B2 — writes to
 * `metadata.unifiedTurn.postStreamGuards` but does NOT replace `fullText`.
 * After 7 days of telemetry we decide whether to escalate to truncate-to-
 * last-sentence or remediation rerun.
 *
 * Two sub-checks:
 *   - "length" — prose > MAX_CONFIRMATION_LEN_CHARS on a successful write
 *     turn. Cheap, deterministic, catches the multi-paragraph case.
 *   - "thinking-out-loud" — prose matches known reasoning-leak phrases.
 *     Catches shorter leaks where length alone wouldn't fire.
 *
 * Returns the FIRST sub-shape that fires (length wins if both match).
 */
const MAX_CONFIRMATION_LEN_CHARS = 240;

/**
 * Phrases the unified-agent prompt's FAILURE GALLERY explicitly forbids
 * (STEP 2 OUTPUT RULE + the cmp2qcnjy "shared reasoning" row).
 * Word-boundary anchored to avoid false positives on substrings.
 */
const THINKING_OUT_LOUD_PATTERNS: readonly RegExp[] = [
  /\bNow I[''']ll\b/i,                     // "Now I'll load the calendar..."
  // "Let me <think-verb>" — NOT "Let me know" (canonical template close).
  /\bLet me (?:check|load|look|update|verify|fetch|see|think|review|reconsider|update the|check the|load the|look at|see if|think about)\b/i,
  /\bI[''']ll (?:load|check|look|update|update the|create the|fetch)\b/i,
  /\bHowever,?\s+looking more carefully\b/i, // The cmp2qcnjy smoking gun
  /\bOn review\b/i,                         // From the old remediation prompt
  /\bLooking (?:more carefully|at this again)\b/i,
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

export const narrationLeakCheck: PostStreamCheck = {
  name: "narration-leak",
  check: ({ fullText, toolCalls }) => {
    // Only fires on turns where SOMETHING got done. A turn with zero writes
    // is owned by narrationWithoutEmitCheck (shape-1); a turn with failed
    // writes is owned by successTheaterCheck (shape-3). This guard targets
    // the "correct action, wrong prose" case.
    const writeToolCalls = toolCalls.filter((tc) => !tc.toolName.startsWith("LOAD_"));
    if (writeToolCalls.length === 0) return { fired: false };
    const anySuccess = writeToolCalls.some((tc) => tc.success === true);
    if (!anySuccess) return { fired: false };

    // Length-cap sub-check. Threshold deliberately generous (240 chars =
    // ~40 words) so the canonical one-sentence templates pass cleanly.
    if (fullText.length > MAX_CONFIRMATION_LEN_CHARS) {
      return {
        fired: true,
        scope: "length",
        reason: `Prose ${fullText.length} chars > ${MAX_CONFIRMATION_LEN_CHARS} char cap (expected one short sentence).`,
      };
    }

    // Thinking-out-loud sub-check.
    if (hasThinkingOutLoudPhrase(fullText)) {
      return {
        fired: true,
        scope: "thinking-out-loud",
        reason: `Prose contains a forbidden "thinking out loud" phrase (Now I'll / Let me / However looking more carefully / etc.).`,
      };
    }

    return { fired: false };
  },
};

// ---------------------------------------------------------------------------
// Default check set
// ---------------------------------------------------------------------------

/**
 * The default post-stream check array a runner caller should use. All
 * three checks run on every turn; they're cheap (regex over a few KB of
 * prose + a flag check over the tool-call array) and partition the failure
 * space cleanly:
 *   - shape-1 (no tools) → narrationWithoutEmitCheck
 *   - shape-3 (failed write, lying prose) → successTheaterCheck
 *   - length / thinking-out-loud (successful write, wrong-shape prose) → narrationLeakCheck
 */
export const DEFAULT_POST_STREAM_CHECKS: readonly PostStreamCheck[] = [
  narrationWithoutEmitCheck,
  successTheaterCheck,
  narrationLeakCheck,
];

// ---------------------------------------------------------------------------
// Runner-facing helper
// ---------------------------------------------------------------------------

export type PostStreamGuardRecord = {
  name: string;
  scope?: string;
  reason?: string;
};

/**
 * Run all post-stream checks against the given input. Returns the list of
 * guards that fired (empty if none). The runner persists this to
 * `metadata.unifiedTurn.postStreamGuards`.
 *
 * Side-effect-free except for one `console.warn` per fire, so admin log
 * scanning surfaces these without needing to query metadata first. v1 is
 * log-only; v2 may add retry per the cost-reduction proposal's Phase 2.
 */
export function runPostStreamChecks(
  input: PostStreamCheckInput,
  checks: readonly PostStreamCheck[] = DEFAULT_POST_STREAM_CHECKS,
): PostStreamGuardRecord[] {
  const fired: PostStreamGuardRecord[] = [];
  for (const c of checks) {
    const result = c.check(input);
    if (!result.fired) continue;
    const rec: PostStreamGuardRecord = {
      name: c.name,
      ...(result.scope ? { scope: result.scope } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    };
    fired.push(rec);
    console.warn(
      `[unified-agent] post-stream check fired: ${c.name}${result.scope ? ` (${result.scope})` : ""} — ${result.reason ?? ""}`,
    );
  }
  return fired;
}
