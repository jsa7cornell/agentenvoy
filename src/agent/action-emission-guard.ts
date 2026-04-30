/**
 * Post-stream validators for Envoy's chat responses.
 *
 * Two parallel checks run after every host-channel composer turn:
 *
 *   1. `needsActionEmissionRetry(text)` — catches "no action emitted at all"
 *      when prose narrates an action. The original 2026-04-18 guard.
 *
 *   2. `needsActionShapeRetry(text, parsedActions)` — catches "action emitted
 *      but wrong shape" when prose narrates delegation but the action's
 *      params don't include the corresponding guestPicks key. Added
 *      2026-04-30 per proposal `2026-04-30_composer-action-fidelity`.
 *
 * Either firing triggers the same retry path. Both checks are stateless —
 * they don't inspect channel context. Stateful routing-correctness checks
 * (Gap A2 from the proposal) are deferred.
 *
 * Usage pattern (see channel/chat/route.ts):
 *   const stream = streamText({...});
 *   let fullText = "";
 *   for await (const chunk of stream.textStream) {
 *     enqueueToClient(chunk);
 *     fullText += chunk;
 *   }
 *   const emissionRetry = needsActionEmissionRetry(fullText);
 *   const shapeRetry = emissionRetry ? null : needsActionShapeRetry(
 *     fullText, parseActions(fullText)
 *   );
 *   if (emissionRetry || shapeRetry) {
 *     const hint = shapeRetry?.hint ?? ACTION_EMISSION_RETRY_PROMPT;
 *     const retry = await generateText({ ..., messages: [...messages,
 *       { role: "assistant", content: fullText },
 *       { role: "user", content: hint },
 *     ] });
 *     enqueueToClient("\n\n" + retry.text);
 *   }
 */

import { ACTIVITY_VOCAB } from "@/lib/activity-vocab";
import type { ActionRequest } from "@/agent/actions";

/**
 * Activity-vocab nouns as a regex alternation, for the "Set up X" pattern.
 * Multi-word entries get \s+ so "bike ride" matches "bike ride", "bike  ride".
 * Co-located with the vocab module so when a new activity lands, the guard's
 * regex follows automatically — drift becomes structurally impossible
 * (proposal §2 Layer 2a).
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
  // Already has an action block — no retry. The [ACTION] check is the live
  // path; the agentenvoy-action fence check is a belt-and-suspenders fallback
  // in case a stale prompt regresses (see proposals/2026-04-18_action-emission-reliability).
  if (/\[ACTION\]/i.test(text)) return false;
  if (/```\s*agentenvoy-action/i.test(text)) return false;

  // Past-tense or ready-state claims of completion. Patterns are anchored to
  // reduce false positives on exploratory text. Each pattern is a distinct
  // failure mode we've seen or reasonably expect.
  const patterns: RegExp[] = [
    // "link is ready", "link ready"  (the Dannyo/Testmania case)
    /\blink\s+(?:is\s+)?ready\b/i,
    // "I've set up / I set up / I've created / I've prepared" + object
    /\b(?:i['’]?ve|i\s+have|i)\s+(?:set\s+up|created|prepared|made|built|added|sent)\s+(?:a|an|the|your|it)\b/i,
    // "Set up a ... meeting/call/event..." — the Testmania case. Anchored to
    // start-of-line so "Want me to set up..." / "I can set up..." don't
    // false-trigger. The failure mode we care about is Envoy's declarative
    // opener ("Set up a 30-min phone call with Dannyo ...").
    //
    // Trailing-noun whitelist: meeting/call/chat/invite/event/thread/link
    // (the original 2026-04-18 set) PLUS activity-vocab nouns (added
    // 2026-04-30 — see proposal §1.2 Gap B). Activity-vocab is the single
    // source of truth; the regex follows when the vocab grows.
    new RegExp(
      `^\\s*set\\s+up\\s+(?:a|an|the)(?:\\s+[\\w-]+){0,4}\\s+(?:meeting|call|chat|invite|event|thread|link|${ACTIVITY_NOUN_ALT})\\b`,
      "im",
    ),
    // "I've archived / I've cancelled / I've confirmed" — other state changes
    /\b(?:i['’]?ve|i\s+have)\s+(?:archived|cancelled|canceled|confirmed|scheduled|booked)\b/i,
    // "Link sent" / "Invite sent" (past-tense claim of send)
    /\b(?:link|invite)\s+sent\b/i,
    // "Done." / "Done — ..." as a standalone claim of completion
    /^\s*done[\s.!—,-]/i,
  ];

  return patterns.some((p) => p.test(text));
}

/**
 * Returns a retry hint when the composer's prose narrates a delegation but
 * the emitted actions don't include the corresponding guestPicks key.
 * Stateless — does NOT inspect channel context. Runs alongside (not instead
 * of) `needsActionEmissionRetry`. See proposal §1.2 Gap A1 + §2 Layer 2b.
 *
 * Examples that fire:
 *   prose:  "she picks the spot"
 *   action: create_link with no guestPicks.location
 *   → returns retry hint
 *
 * Examples that do NOT fire:
 *   prose:  "she picks the spot"
 *   action: create_link with guestPicks.location: true
 *   → returns null (coherent — prose matches action shape)
 *
 *   prose:  "(no delegation language)"
 *   action: anything
 *   → returns null
 *
 * Returns `null` for either "no delegation prose detected" or "delegation
 * detected and action shape is correct." Either case skips retry.
 */
export function needsActionShapeRetry(
  text: string,
  parsedActions: ActionRequest[],
): { hint: string; flaggedReason: string } | null {
  if (!text) return null;

  // Delegation patterns → required guestPicks key.
  // Order matters: more-specific patterns first so a "she picks the spot"
  // doesn't get swallowed by a generic "she picks" → location heuristic.
  const delegationPatterns: Array<{
    rx: RegExp;
    field: "location" | "duration" | "format" | "date";
    name: string;
  }> = [
    // "she/he/they pick(s)/will pick the LOCATION/SPOT/PLACE"
    {
      rx: /\b(she|he|they)\s+(?:pick|picks|chooses|will\s+pick|gets\s+to\s+pick|can\s+pick|will\s+choose)\b[\s\w,]{0,40}\b(?:spot|location|place|where)\b/i,
      field: "location",
      name: "delegation:location",
    },
    // "she/he/they pick(s)/will pick the DAY/TIME/WHEN"
    {
      rx: /\b(she|he|they)\s+(?:pick|picks|chooses|will\s+pick|gets\s+to\s+pick|can\s+pick)\b[\s\w,]{0,40}\b(?:day|time|when)\b/i,
      field: "date",
      name: "delegation:date",
    },
    // "she/he/they pick(s)/will pick the LENGTH/HOW LONG/DURATION"
    {
      rx: /\b(she|he|they)\s+(?:pick|picks|chooses|will\s+pick|gets\s+to\s+pick|can\s+pick)\b[\s\w,]{0,40}\b(?:length|how\s+long|duration)\b/i,
      field: "duration",
      name: "delegation:duration",
    },
    // "she/he/they pick(s)/will pick the FORMAT/VIDEO/PHONE/IN-PERSON"
    {
      rx: /\b(she|he|they)\s+(?:pick|picks|chooses|will\s+pick|gets\s+to\s+pick|can\s+pick)\b[\s\w,]{0,40}\b(?:format|video|phone|in[-\s]person)\b/i,
      field: "format",
      name: "delegation:format",
    },
    // "let her/him/them choose/pick/decide [field]"
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
    // "wherever works for them/her/him" — location deferral
    {
      rx: /\bwherever\s+(?:works|is\s+best)\s+for\s+(?:her|him|them)\b/i,
      field: "location",
      name: "wherever-works",
    },
  ];

  for (const { rx, field, name } of delegationPatterns) {
    if (!rx.test(text)) continue;
    // Prose says delegation. Is there a matching guestPicks key in any action?
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

/**
 * Terse reminder for the retry call. The LLM should emit ONLY the action
 * block, no conversational text. Concatenated with the first response so
 * the user sees one coherent message (their UI strips the action block).
 */
export const ACTION_EMISSION_RETRY_PROMPT =
  "You just described an action but didn't emit the corresponding `[ACTION]{...}[/ACTION]` block. Emit the block now — ONLY the block, no conversational text, no preamble. If multiple actions apply, emit multiple blocks. Use the exact format and fields documented in the system prompt.";
