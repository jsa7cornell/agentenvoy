import { test } from "@playwright/test";

// Canonical regression seed for cmp4ss1ip (2026-05-14 LOG):
//   On a deal-room session that was previously confirmed (`status: agreed`,
//   real `agreedTime` + `calendarEventId`), the host or guest invokes
//   `session_request_reschedule` via the chat ("reschedule to tomorrow",
//   "cancel meeting", etc.). The server-side handler runs to completion:
//   GCal event deleted, NegotiationSession reset to `status: active` with
//   `agreedTime: null` / `calendarEventId: null`, system message inserted.
//
//   Pre-fix, the client's `applySessionFromServer` reducer only invalidated
//   `confirmData` for the `cancelled` / `retime_proposed` case-arms. The
//   `agreed → active` transition fell through the `default:` branch
//   (intentionally — to handle the picker-optimistic race window
//   `active → agreed`). Result: the green "CONFIRMED BY <guest>" hero
//   stayed rendered indefinitely on a session the server had already
//   reset, until a hard refresh.
//
//   Fix (commit 49cfec8): extracted
//   `shouldInvalidateConfirmedOnStatusTransition(prev, next)` — returns
//   true ONLY for `agreed → active`. Reducer tracks previous server status
//   via `prevServerStatusRef` (useRef) and clears `confirmed` + `confirmData`
//   when the helper fires.
//
// ── Variant axis this spec must exercise ──────────────────────────────────
// The directional rule's matrix is `{prev} × {next}` with the SessionStatus
// values: active, proposed, agreed, retime_proposed, cancelled. The pure
// helper's behavior is locked in by 12 unit-test cells in
// `src/__tests__/unit/deal-room-status-transition.test.ts`; this Playwright
// spec exercises the END-TO-END wiring (server-driven status transitions
// flow through the polling reducer and produce the expected card render).
//
// Required variant cells for end-to-end coverage:
//
//   A. `agreed → active` (the bug — host requests reschedule)
//      Setup: agreed session w/ calendarEventId.
//      Action: send "reschedule to tomorrow" via chat as host.
//      Assert: within 2 polling ticks (~20s), the green CONFIRMED hero
//      disappears AND the proposal-state card is rendered (picker visible
//      for guest viewer, "TBD — pick a time below" copy visible).
//
//   B. `agreed → active` (guest variant — guest requests reschedule)
//      Same as A but the guest sends the message. The reducer-level fix
//      is role-agnostic but the system-message copy differs ("guest"
//      vs "host"); spec confirms the guest path doesn't regress.
//
//   C. `active → agreed` (picker-optimistic race — MUST preserve confirmData)
//      Setup: fresh active session.
//      Action: guest picks a slot through the picker; client optimistically
//      sets confirmData; first polling tick returns `status: active` still
//      (mid-merge); second tick returns `status: agreed`.
//      Assert: the green CONFIRMED hero appears and stays — the directional
//      check must NOT clear optimistic confirmData on the first tick.
//      This is the regression cell the fix's directional check protects.
//
//   D. `agreed → cancelled` (owned by the cancelled case-arm — must not double-clear)
//      Setup: agreed session.
//      Action: archive the session via `session_set_archived` tool.
//      Assert: card transitions through cancelled state (the case-arm fires,
//      not the helper). Confirms the helper doesn't false-fire on
//      transitions other case-arms own.
//
//   E. `agreed → retime_proposed` (owned by retime_proposed case-arm)
//      Setup: agreed session.
//      Action: host invokes `session_update_time` to propose a new slot.
//      Assert: card transitions through retime_proposed state; case-arm
//      clears confirmData, picker re-proposes.
//
// Why this is skipped today:
//   Authoring the full spec requires three infrastructure pieces that
//   don't exist yet in `e2e/_helpers/`:
//
//   1. **Test-user JWT mint + cookie injection** — to authenticate the
//      host browser context. No endpoint at the moment;
//      `e2e/_helpers/README.md` flags this as a future need.
//   2. **Personal-link create via API** — `POST /api/me/links` with the
//      test-user JWT to seed the link. Endpoint exists but the helper
//      wrapper for tests doesn't.
//   3. **Agreed-session seeding** — the killer. To reach `status: agreed`
//      with a real `calendarEventId`, the guest has to pick a slot through
//      the actual confirm path (which calls Google Calendar's events.insert
//      API). For tests we need either (a) a GCal mock at the integration
//      boundary or (b) a test-only `/api/test/seed-agreed-session` endpoint
//      that fabricates the row with a sentinel calendarEventId the GCal
//      stub recognizes. The README explicitly says option (b) requires a
//      follow-up proposal (motivate the test-only endpoint at code review).
//
// What's protecting against regressions today:
//   - `src/__tests__/unit/deal-room-status-transition.test.ts` — 12-cell
//     directional matrix on the pure helper. Locks in the contract:
//     ONLY `agreed → active` returns true; no other (prev, next) pair does.
//     The exhaustive matrix asserts the count of true-returning cells is
//     exactly 1, so a future refactor that accidentally widens the rule
//     fails the test.
//   - Manual browser verification — the user verified the post-fix end
//     state on prod (link `aw8azt`) after Vercel auto-deployed commit
//     49cfec8: guest view shows clean proposal card + picker, no green
//     confirmed hero. Screenshots in the cmp4ss1ip triage thread.
//
// When you implement: replace `test.skip` with `test`, delete the
// "Why this is skipped" banner above, and verify the spec actually catches
// the regression — revert the helper's `agreed → active` check on a scratch
// branch and confirm variant A fails with a clear assertion before
// restoring + confirming it passes. Per PLAYBOOK Rule 29: "a spec that
// doesn't fail on the reverted state is a spec that doesn't catch the
// regression."
//
// Reference: proposals/2026-05-13_claude-production-verification-infra_
//   reviewed-2026-05-13_decided-2026-05-13.md (Layer 1).

test.skip("deal-room reschedule clears stale CONFIRMED card on next polling tick (cmp4ss1ip)", async ({
  page,
}) => {
  // TODO(infra-pass): test-user JWT mint endpoint + cookie injection helper.
  //   File: e2e/_helpers/auth.ts (does not exist yet).
  // TODO(infra-pass): create-link API wrapper.
  //   File: e2e/_helpers/createPersonalLink.ts (does not exist yet).
  // TODO(infra-pass): agreed-session seed.
  //   Either (a) GCal integration mock, or (b) test-only seed endpoint
  //   per `e2e/_helpers/README.md` option 1. The latter requires a follow-up
  //   proposal as the README states.
  //
  // Variant A (the bug):
  //   - Seed an agreed session for the test host + a fake guest.
  //   - Navigate to /meet/<slug>/<code> as the guest.
  //   - Assert green "CONFIRMED BY <guest>" eyebrow is visible.
  //   - POST a "reschedule to tomorrow" message via /api/dealroom/chat
  //     (or whatever the deal-room chat endpoint is) as the host.
  //   - Wait up to 20s (two polling intervals) for the card to re-render.
  //   - Assert: green eyebrow is gone AND "TBD — pick a time below" copy
  //     is visible AND picker grid is visible.
  //   - Use ARIA roles where possible — the picker's day-cells should be
  //     `role="button"` with `aria-label` like "Thursday May 14, 3 windows
  //     available". If they're not, fix the markup in the same PR.
  void page;
});
