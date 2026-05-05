/**
 * _shared/post-stream-guards — Layer 2a/2b/F6 stateless prose-coherence
 * checks, exported as `PostStreamGuard` instances + the underlying detector
 * functions.
 *
 * Per proposal §1.1.3: these guards are stateless and surface-agnostic; they
 * become the *default* postStreamGuards on every module that emits actions.
 * Modules can opt out via `useDefaultPostStreamGuards: false` (per Ni4).
 *
 * History
 *  - Functions originally lived in `src/agent/action-emission-guard.ts`
 *    (2026-04-18 Layer 2a; 2026-04-30 Layer 2b; 2026-05-01 F6).
 *  - PR1a wrapped them as PostStreamGuard re-exports.
 *  - PR3a (this file) absorbs the bodies entirely; `action-emission-guard.ts`
 *    is deleted. The legacy file's import sites import the same symbols
 *    from here until PR3b retires the inline schedule-path orchestration in
 *    favor of `runModule`.
 */
import { ACTIVITY_VOCAB } from "@/lib/activity-vocab";
import type { ActionRequest } from "@/agent/actions";
import type { PostStreamGuard } from "../../types";

// ---------------------------------------------------------------------------
// Retry hints
// ---------------------------------------------------------------------------

/**
 * Retry hint when prose narrates an action but no `[ACTION]` block was emitted.
 * Concatenated with the first response so the user sees one coherent message
 * (their UI strips the action block).
 */
export const ACTION_EMISSION_RETRY_PROMPT =
  "You just described an action but didn't emit the corresponding `[ACTION]{...}[/ACTION]` block. Emit the block now — ONLY the block, no conversational text, no preamble. If multiple actions apply, emit multiple blocks. Use the exact format and fields documented in the system prompt.";

/**
 * Retry hint for the F6 false-apology / duplicate-re-emit case. Tells the
 * composer that prior actions DID run (they're always persisted before the
 * next turn) and instructs it to drop the redundant emit, responding only
 * to the host's current request.
 */
export const ACTION_REDUNDANCY_RETRY_PROMPT =
  "Your prior turn's actions ran successfully — see the `actionResults` blocks in conversation history. Don't re-emit prior actions; they're already in the host's dashboard. Re-read the host's MOST RECENT message and respond to that fresh: emit `[ACTION]` blocks ONLY for what the host's current message asks for, nothing else. If you're unsure whether a prior action ran, default to NOT re-emitting (the actionResults in history are authoritative).";

// ---------------------------------------------------------------------------
// Layer 2a — emission guard
// ---------------------------------------------------------------------------

/**
 * Activity-vocab nouns as a regex alternation, for the "Set up X" pattern.
 * Multi-word entries get \s+ so "bike ride" matches "bike ride", "bike  ride".
 * Co-located with the vocab module so when a new activity lands, the guard's
 * regex follows automatically — drift becomes structurally impossible.
 */
const ACTIVITY_NOUN_ALT = ACTIVITY_VOCAB
  .map((e) => e.name.replace(/\s+/g, "\\s+"))
  .join("|");

/**
 * Returns true when the text CLAIMS a state-changing action occurred but
 * does NOT include an emit block. Conservative — false positives annoy the
 * LLM with pointless retries; false negatives let bad responses through.
 * We err toward false negatives.
 */
export function needsActionEmissionRetry(text: string): boolean {
  if (!text) return false;
  if (/\[ACTION\]/i.test(text)) return false;
  if (/```\s*agentenvoy-action/i.test(text)) return false;

  const patterns: RegExp[] = [
    /\blink\s+(?:is\s+)?ready\b/i,
    /\b(?:i['’]?ve|i\s+have|i)\s+(?:set\s+up|created|prepared|made|built|added|sent)\s+(?:a|an|the|your|it)\b/i,
    new RegExp(
      `^\\s*set\\s+up\\s+(?:a|an|the)(?:\\s+[\\w-]+){0,4}\\s+(?:meeting|call|chat|invite|event|thread|link|${ACTIVITY_NOUN_ALT})\\b`,
      "im",
    ),
    /\b(?:i['’]?ve|i\s+have)\s+(?:archived|cancelled|canceled|confirmed|scheduled|booked)\b/i,
    /\b(?:link|invite)\s+sent\b/i,
    /^\s*done[\s.!—,-]/i,
  ];

  return patterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Layer 2b — shape guard
// ---------------------------------------------------------------------------

/**
 * Returns a retry hint when the composer's prose narrates a delegation but
 * the emitted actions don't include the corresponding guestPicks key.
 * Stateless — does NOT inspect channel context.
 */
export function needsActionShapeRetry(
  text: string,
  parsedActions: ActionRequest[],
): { hint: string; flaggedReason: string } | null {
  if (!text) return null;

  const delegationPatterns: Array<{
    rx: RegExp;
    field: "location" | "duration" | "format" | "date";
    name: string;
  }> = [
    {
      rx: /\b(she|he|they)\s+(?:pick|picks|chooses|will\s+pick|gets\s+to\s+pick|can\s+pick|will\s+choose)\b[\s\w,]{0,40}\b(?:spot|location|place|where)\b/i,
      field: "location",
      name: "delegation:location",
    },
    {
      rx: /\b(she|he|they)\s+(?:pick|picks|chooses|will\s+pick|gets\s+to\s+pick|can\s+pick)\b[\s\w,]{0,40}\b(?:day|time|when)\b/i,
      field: "date",
      name: "delegation:date",
    },
    {
      rx: /\b(she|he|they)\s+(?:pick|picks|chooses|will\s+pick|gets\s+to\s+pick|can\s+pick)\b[\s\w,]{0,40}\b(?:length|how\s+long|duration)\b/i,
      field: "duration",
      name: "delegation:duration",
    },
    {
      rx: /\b(she|he|they)\s+(?:pick|picks|chooses|will\s+pick|gets\s+to\s+pick|can\s+pick)\b[\s\w,]{0,40}\b(?:format|video|phone|in[-\s]person)\b/i,
      field: "format",
      name: "delegation:format",
    },
    {
      rx: /\blet\s+(?:her|him|them)\s+(?:choose|pick|decide)\b[\s\w,]{0,40}\b(?:spot|location|place|where)\b/i,
      field: "location",
      name: "let-them-pick:location",
    },
    {
      rx: /\blet\s+(?:her|him|them)\s+(?:choose|pick|decide)\b[\s\w,]{0,40}\b(?:day|time|when)\b/i,
      field: "date",
      name: "let-them-pick:date",
    },
    {
      rx: /\blet\s+(?:her|him|them)\s+(?:choose|pick|decide)\b[\s\w,]{0,40}\b(?:length|how\s+long|duration)\b/i,
      field: "duration",
      name: "let-them-pick:duration",
    },
    {
      rx: /\blet\s+(?:her|him|them)\s+(?:choose|pick|decide)\b[\s\w,]{0,40}\b(?:format|video|phone|in[-\s]person)\b/i,
      field: "format",
      name: "let-them-pick:format",
    },
    {
      rx: /\bwherever\s+(?:works|is\s+best)\s+for\s+(?:her|him|them)\b/i,
      field: "location",
      name: "wherever-works",
    },
  ];

  for (const { rx, field, name } of delegationPatterns) {
    if (!rx.test(text)) continue;
    const hasMatchingKey = parsedActions.some((a) => {
      const params = a.params as Record<string, unknown> | undefined;
      const gp = params?.guestPicks as Record<string, unknown> | undefined;
      if (!gp) return false;
      const v = gp[field];
      return v === true || (Array.isArray(v) && v.length > 0);
    });
    if (!hasMatchingKey) {
      const fieldLabel =
        field === "duration"
          ? "length"
          : field === "date"
            ? "day"
            : field;
      return {
        flaggedReason: name,
        hint: `Your response said the guest picks the ${fieldLabel}, but the emitted action doesn't include guestPicks.${field}: true. Re-emit the action with guestPicks.${field}: true added to params, OR clarify with the host whether the field is actually deferred.`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// F6 — redundancy guard
// ---------------------------------------------------------------------------

/**
 * Returns a retry hint when the composer's prose narrates a false-apology
 * for a prior turn that DID emit successfully — typically followed by a
 * duplicate `create_link` re-emission of the prior action. F6 — proposal
 * `2026-04-30_composer-action-fidelity` §2 catalogue (2026-05-01).
 */
export function needsActionRedundancyRetry(
  text: string,
  parsedActions: ActionRequest[],
): { hint: string; flaggedReason: string } | null {
  if (!text) return null;
  if (parsedActions.length === 0) return null;

  const patterns: Array<{ rx: RegExp; name: string }> = [
    {
      rx: /\b(apolog(?:y|ies|ize))[\s,.—–\-:!]+[\s\S]{0,80}\b(?:hadn'?t|didn'?t|forgot(?:\s+to)?|missed|haven'?t)\s+(?:emit|emitted|create|created|sent|set\s+up|made|built)\b/i,
      name: "apology-retry:hadnt-emitted",
    },
    {
      rx: /\bi\s+got\s+ahead\s+of\s+myself\b/i,
      name: "apology-retry:got-ahead",
    },
    {
      rx: /\blet\s+me\s+(?:re-?emit|emit\s+(?:that\s+)?again|try\s+(?:that|this)\s+again|retry\s+(?:that|this))\b/i,
      name: "apology-retry:let-me-retry",
    },
    {
      rx: /\bthat'?s\s+now\s+(?:created|done|emitted|set\s+up|in\s+place|sent)\b/i,
      name: "apology-retry:thats-now-x",
    },
    {
      rx: /\bi\s+(?:should\s+have|meant\s+to)\s+(?:emit|emitted|create|created|sent|made|built|set\s+up)\b/i,
      name: "apology-retry:should-have",
    },
  ];

  for (const { rx, name } of patterns) {
    if (!rx.test(text)) continue;
    return {
      flaggedReason: name,
      hint: ACTION_REDUNDANCY_RETRY_PROMPT,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Narration↔emission consistency — claim-without-emit guard
// ---------------------------------------------------------------------------

/**
 * Retry hint when prose claims a state-changing effect ("now blocked",
 * "is now protected", "the action I emitted stands") but no action was
 * emitted. Typical cause: a preEmit guard suppressed the action on a
 * prior retry and the composer re-narrated as if the action stood.
 *
 * Cross-reference: `proposals/2026-05-05_state-integrity-and-architectural-attention-bias.md`.
 */
export const NARRATION_EMISSION_CONSISTENCY_RETRY_PROMPT =
  "Your previous reply claimed a state change (e.g. \"now blocked\", \"is updated\", \"the action I emitted stands\") but you did not emit a corresponding `[ACTION]` block — likely because a pre-emit guard suppressed it earlier this turn, or you forgot to emit. Re-narrate WITHOUT claiming the effect happened. Either (a) surface the conflict / blocker honestly and ask the host to confirm, or (b) ask a clarifying question. Do NOT assert that the change is already done.";

/**
 * Patterns that match composer prose CLAIMING a state-change effect already
 * happened. Verb-shaped only — passive read-only narration like
 * "Your timezone is set to EDT" must NOT match (that's a state report,
 * not a write claim).
 *
 * Production-observed shapes (FeedbackReport `cmot66ofp`, `cmot69r49`):
 *   - "Friday May 8 is now fully protected"
 *   - "Tuesday May 12, 9 AM-noon is blocked... The action I emitted stands"
 *
 * Discipline: limit to write-effect verbs (blocked/protected/locked/updated/
 * created/cancelled/archived/rescheduled). Skip read verbs ("set to", "shows",
 * "looks like"). Anchor on "now <verb>" or "<verb>. The action I emitted ...".
 */
const NARRATION_CLAIM_PATTERNS: Array<{ rx: RegExp; name: string }> = [
  // "X is now (fully) blocked|protected|locked|updated|created|cancelled|archived|rescheduled|set up|in place"
  {
    rx: /\bis\s+now\s+(?:fully\s+)?(?:blocked|protected|locked|updated|created|cancell?ed|archived|rescheduled|set\s+up|in\s+place)\b/i,
    name: "is-now-effect",
  },
  // "now fully blocked|protected|locked|updated|in place" (e.g. "Friday is now fully protected")
  {
    rx: /\bnow\s+fully\s+(?:blocked|protected|locked|updated|in\s+place)\b/i,
    name: "now-fully-effect",
  },
  // "the action I emitted (stands|landed|went through|is in place)"
  {
    rx: /\bthe\s+action\s+I\s+emitted\s+(?:stands|landed|went\s+through|is\s+in\s+place)\b/i,
    name: "action-i-emitted-stands",
  },
  // "I've|I have (just) blocked|protected|locked|cancelled|archived|rescheduled X"
  // Layer 2a covers other write-verb phrasings text-only; we add the parity
  // check (no parsedActions) for these tighter write verbs.
  {
    rx: /\bI(?:['’]?ve|\s+have)\s+(?:just\s+)?(?:blocked|protected|locked|cancell?ed|archived|rescheduled)\b/i,
    name: "i-have-write-verb",
  },
];

/**
 * Returns a retry hint when the composer's prose makes a write-effect claim
 * but no action was parsed from the response. Stateless — consults only the
 * text and the parsed actions.
 *
 * The runner runs this guard BEFORE action dispatch, so we can't check
 * `actionResults` for success. But the failure mode (preEmit suppressed the
 * action on a prior retry; composer re-narrates as if the action stood) is
 * fully captured by `parsedActions.length === 0` + claim prose: the retry's
 * `parsedActions` IS empty in those cases.
 */
export function needsNarrationEmissionRetry(
  text: string,
  parsedActions: ActionRequest[],
): { hint: string; flaggedReason: string } | null {
  if (!text) return null;
  if (parsedActions.length > 0) return null;

  for (const { rx, name } of NARRATION_CLAIM_PATTERNS) {
    if (!rx.test(text)) continue;
    return {
      flaggedReason: `claim-without-emit:${name}`,
      hint: NARRATION_EMISSION_CONSISTENCY_RETRY_PROMPT,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PostStreamGuard wrappers
// ---------------------------------------------------------------------------

/**
 * Layer 2a — emission guard. Catches "I set up the link" prose without an
 * accompanying [ACTION] block. Original 2026-04-18 guard.
 */
export const layer2aEmissionGuard: PostStreamGuard = {
  name: "layer-2a-emission",
  check: ({ text }) => {
    if (!needsActionEmissionRetry(text)) return null;
    return {
      flaggedReason: "no-action-emitted",
      hint: ACTION_EMISSION_RETRY_PROMPT,
    };
  },
};

/**
 * Layer 2b — shape guard. Catches "she picks the spot" prose with a
 * `create_link`/`update_link` action that doesn't have `guestPicks.location: true`.
 * Added 2026-04-30 per `composer-action-fidelity` proposal.
 */
export const layer2bShapeGuard: PostStreamGuard = {
  name: "layer-2b-shape",
  check: ({ text, parsedActions }) => {
    const result = needsActionShapeRetry(text, parsedActions);
    if (!result) return null;
    return { flaggedReason: result.flaggedReason, hint: result.hint };
  },
};

/**
 * F6 redundancy guard. Catches "Apologies — I hadn't emitted X yet" prose
 * paired with an [ACTION] block (the false-apology-then-duplicate-emit pattern).
 * Added 2026-05-01 per F6 row in COMPOSER.md §2.
 */
export const f6RedundancyGuard: PostStreamGuard = {
  name: "f6-redundancy",
  check: ({ text, parsedActions }) => {
    const result = needsActionRedundancyRetry(text, parsedActions);
    if (!result) return null;
    return { flaggedReason: result.flaggedReason, hint: result.hint };
  },
};

/**
 * Narration↔emission consistency guard. Catches the
 * "Friday is now fully protected" + `parsedActions: []` shape — composer
 * narrating a write effect that didn't emit (typically because a preEmit
 * guard suppressed the prior emission and the composer didn't propagate
 * that into its retry prose).
 *
 * Added 2026-05-05 per FeedbackReport `cmot66ofp` / `cmot69r49`. Cross-ref
 * `proposals/2026-05-05_state-integrity-and-architectural-attention-bias.md`.
 *
 * Scope discipline: this guard ships in the default set, and inquire (the
 * cluster most prone to read-only "is set to" narration) opts out via
 * `useDefaultPostStreamGuards: false`. The regex set is also verb-shaped
 * (write verbs only) as a second line of defense against false positives.
 */
export const narrationEmissionConsistencyGuard: PostStreamGuard = {
  name: "narration-emission-consistency",
  check: ({ text, parsedActions }) => {
    const result = needsNarrationEmissionRetry(text, parsedActions);
    if (!result) return null;
    return { flaggedReason: result.flaggedReason, hint: result.hint };
  },
};

/**
 * Default guard set auto-injected by the runner unless the module sets
 * `useDefaultPostStreamGuards: false`.
 *
 * Order matters: emission first (loudest case), then shape, then redundancy,
 * then narration↔emission consistency (catches the residual "claim survived
 * the retry but no action did" case the others don't cover). The runner
 * short-circuits on the first firing, so earlier-listed guards have priority.
 */
export const DEFAULT_POST_STREAM_GUARDS: readonly PostStreamGuard[] = [
  layer2aEmissionGuard,
  layer2bShapeGuard,
  f6RedundancyGuard,
  narrationEmissionConsistencyGuard,
];
