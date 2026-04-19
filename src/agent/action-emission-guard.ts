/**
 * Post-stream validator for Envoy's chat responses.
 *
 * Failure mode we're defending against: the LLM writes prose like "link ready"
 * or "I've set it up" but forgets to emit the matching [ACTION]{...}[/ACTION]
 * block. The user sees the message but nothing actually happened. See
 * channel/chat for context.
 *
 * Usage pattern (see channel/chat/route.ts):
 *   const stream = streamText({...});
 *   let fullText = "";
 *   for await (const chunk of stream.textStream) {
 *     enqueueToClient(chunk);
 *     fullText += chunk;
 *   }
 *   if (needsActionEmissionRetry(fullText)) {
 *     const retry = await generateText({ ..., messages: [...messages,
 *       { role: "assistant", content: fullText },
 *       { role: "user", content: ACTION_EMISSION_RETRY_PROMPT },
 *     ] });
 *     enqueueToClient("\n\n" + retry.text);
 *   }
 */

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
    /\b(?:i['\u2019]?ve|i\s+have|i)\s+(?:set\s+up|created|prepared|made|built|added|sent)\s+(?:a|an|the|your|it)\b/i,
    // "Set up a ... meeting/call/event..." — the Testmania case. Anchored to
    // start-of-line so "Want me to set up..." / "I can set up..." don't
    // false-trigger. The failure mode we care about is Envoy's declarative
    // opener ("Set up a 30-min phone call with Dannyo ...").
    /^\s*set\s+up\s+(?:a|an|the)(?:\s+[\w-]+){0,4}\s+(?:meeting|call|chat|invite|event|thread|link)\b/im,
    // "I've archived / I've cancelled / I've confirmed" — other state changes
    /\b(?:i['\u2019]?ve|i\s+have)\s+(?:archived|cancelled|canceled|confirmed|scheduled|booked)\b/i,
    // "Link sent" / "Invite sent" (past-tense claim of send)
    /\b(?:link|invite)\s+sent\b/i,
    // "Done." / "Done — ..." as a standalone claim of completion
    /^\s*done[\s.!—,-]/i,
  ];

  return patterns.some((p) => p.test(text));
}

/**
 * Terse reminder for the retry call. The LLM should emit ONLY the action
 * block, no conversational text. Concatenated with the first response so
 * the user sees one coherent message (their UI strips the action block).
 */
export const ACTION_EMISSION_RETRY_PROMPT =
  "You just described an action but didn't emit the corresponding `[ACTION]{...}[/ACTION]` block. Emit the block now — ONLY the block, no conversational text, no preamble. If multiple actions apply, emit multiple blocks. Use the exact format and fields documented in the system prompt.";
