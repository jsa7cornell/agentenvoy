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
 * triage + the cost-reduction case study:
 *   - "Wednesday afternoon is now blocked" (cmp1nni72)
 *   - "Friday May 8 is now fully protected"
 *   - "Got it — updated location to Konditori" (dealroom past-tense template)
 *   - "Done — moved it to Thursday 3pm"
 *   - "Booked Friday 2pm" / "Cancelled" / "Created the link"
 *   - "I've blocked Friday" / "I've rescheduled it"
 *
 * Five regexes union'd — each catches a different verb-shape so the gate's
 * sensitivity is independent of which template the model picks.
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
// Default check set
// ---------------------------------------------------------------------------

/**
 * The default post-stream check array a runner caller should use. Both
 * checks run on every turn; they're cheap (regex over a few KB of prose +
 * a flag check over the tool-call array) and partition the failure space
 * cleanly.
 */
export const DEFAULT_POST_STREAM_CHECKS: readonly PostStreamCheck[] = [
  narrationWithoutEmitCheck,
  successTheaterCheck,
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
