/**
 * Fresh-create gate (F14 Phase 3.B).
 *
 * Decides whether a bookable-link turn should run with a fresh prompt
 * (historyLimit:0) or as a continuation (historyLimit:4) of an in-flight
 * Bookable Link session.
 *
 * Heuristic: a continuation iff ANY of the last N envoy turns contains the
 * keyword "bookable". Covers the proposal turn, iterative-tweak turns
 * (which may not say "bookable" explicitly), and the post-creation
 * "link is live" turn. historyLimit:4 is safe with that detection.
 *
 * Centralized here so PR2's create_bookable_link branch + the create_link
 * bookable-fallback branch share the same logic. Pre-PR2 it was inlined
 * twice in chat/route.ts.
 */

const CONTINUATION_KEYWORD = /bookable/i;

export interface FreshCreateGateInput {
  /** Recent envoy-role channel message contents, newest first or oldest first; order doesn't matter. */
  recentEnvoyContents: readonly string[];
  /** Override window. Defaults to 3 (matches pre-PR2 behavior). */
  lookbackTurns?: number;
}

export interface FreshCreateGateOutput {
  isContinuation: boolean;
  historyLimit: number;
}

export function evaluateFreshCreateGate(
  input: FreshCreateGateInput,
): FreshCreateGateOutput {
  const window = input.recentEnvoyContents.slice(0, input.lookbackTurns ?? 3);
  const isContinuation = window.some((c) => CONTINUATION_KEYWORD.test(c));
  return {
    isContinuation,
    historyLimit: isContinuation ? 4 : 0,
  };
}
