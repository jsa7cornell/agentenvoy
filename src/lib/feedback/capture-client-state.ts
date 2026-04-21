/**
 * Snapshot the browser state at feedback-submit time (T3b of
 * proposals/2026-04-21). Pure DOM-read; safe to call at submit-click.
 *
 * Never throws — returns a best-effort object the server stores in
 * FeedbackReport.clientState. Caller shouldn't block submit on this.
 *
 * PII posture: user-device context only. No third-party data.
 */

import type { ClientState } from "@/lib/feedback/schema";

export interface CaptureOpts {
  /** Any half-edited form state the mounting component wants to include.
   *  Keys should be stable — the bundle viewer renders them verbatim. */
  pendingUI?: Record<string, unknown>;
  /** The most recent message ID the user scrolled past — the caller can
   *  pass this from a render-list ref. Optional. */
  lastSeenMessageId?: string | null;
}

export function captureClientState(opts: CaptureOpts = {}): ClientState {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {};
  }
  const state: ClientState = {};
  try {
    state.locationHash = window.location.hash || null;
  } catch {
    /* ignore */
  }
  try {
    const focused = document.activeElement as HTMLElement | null;
    state.focusedElementId = focused?.id || null;
    const derived = deriveSessionFromFocus(focused);
    const fromHash = deriveSessionFromHash(state.locationHash ?? "");
    state.focusedSessionId = derived ?? fromHash ?? null;
  } catch {
    state.focusedElementId = null;
    state.focusedSessionId = null;
  }
  try {
    state.viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* ignore */
  }
  try {
    state.viewport = {
      w: Math.floor(window.innerWidth || 0),
      h: Math.floor(window.innerHeight || 0),
    };
  } catch {
    /* ignore */
  }
  if (opts.lastSeenMessageId !== undefined) {
    state.lastSeenMessageId = opts.lastSeenMessageId;
  }
  if (opts.pendingUI) {
    state.pendingUI = opts.pendingUI;
  }
  return state;
}

function deriveSessionFromFocus(el: HTMLElement | null): string | null {
  if (!el) return null;
  // Focused element may carry `data-session-id` or its id can be e.g.
  // "card-cmo85p..." — walk up to find a data-session-id attribute.
  let cur: HTMLElement | null = el;
  for (let i = 0; i < 5 && cur; i++) {
    const sid = cur.getAttribute("data-session-id");
    if (sid) return sid;
    cur = cur.parentElement;
  }
  return null;
}

function deriveSessionFromHash(hash: string): string | null {
  const m = /#session-([A-Za-z0-9_-]+)/.exec(hash);
  return m ? m[1] : null;
}
