/**
 * External-agent primer persistence — Stage 3 of proposal
 * `2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity`.
 *
 * Implements Rule V2 (§7 of the decided proposal) — N4 fold:
 *   "seenPrimers is persisted via localStorage keyed by
 *    seen-primer:<sessionId>:<external_agent_identity>, with cleanup on
 *    terminal confirmed state."
 *
 * localStorage (not sessionStorage) so a reload within the same session
 * doesn't re-trigger the primer. Client-only; no server/schema churn for a
 * cosmetic flag. SSR-safe: all functions no-op (hasSeenPrimer returns true
 * so the primer never renders on the server) when `window` is undefined.
 *
 * Cleanup on `confirmed` terminal state is best-effort; the keys are
 * session-scoped so they won't accumulate meaningfully even if cleanup
 * doesn't run.
 */

const KEY = (sessionId: string, agentIdentity: string): string =>
  `seen-primer:${sessionId}:${agentIdentity}`;

export function hasSeenPrimer(
  sessionId: string,
  agentIdentity: string,
): boolean {
  // SSR: treat as seen so the primer never flashes on the server render.
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(KEY(sessionId, agentIdentity)) === "1";
  } catch {
    // Storage disabled (Safari private mode, quota, etc.) — don't spam the
    // primer in a hot loop. Treat as seen.
    return true;
  }
}

export function markPrimerSeen(
  sessionId: string,
  agentIdentity: string,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY(sessionId, agentIdentity), "1");
  } catch {
    // Swallow — see hasSeenPrimer comment.
  }
}

/**
 * Remove every primer key scoped to this session. Called when the session
 * transitions to the `confirmed` terminal state so stale keys don't accrue
 * indefinitely. Scoped by sessionId prefix so cleanup never touches other
 * sessions' primer state on the same device.
 */
export function cleanupPrimersForSession(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    const prefix = `seen-primer:${sessionId}:`;
    // Iterate in reverse so removeItem doesn't skip indices during the walk.
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix)) window.localStorage.removeItem(k);
    }
  } catch {
    // Best-effort; silent failure is acceptable here.
  }
}
