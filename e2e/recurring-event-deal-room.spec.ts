import { test } from "@playwright/test";

// Canonical regression seed for cmp4xju6z (2026-05-14 LOG):
//   Visiting a recurring-meeting deal-room URL as a guest rendered the event
//   as a one-off — no "weekly" eyebrow, no cadence subtitle, no 🔁 badge.
//   The host's dashboard link card showed "weekly · 105 min" correctly; the
//   regression was scoped to the deal-room/event-page reader path.
//
//   Root cause: `link.recurrence` was never included in the session API
//   response (`/api/negotiate/session`), so `deal-room.tsx`'s `linkRecurrence`
//   state stayed null and `dealRoomToMeetingCardProps` never populated the
//   `series` field on `MeetingCardProps`.
//
//   Fix (PR1 of proposal 2026-05-14_recurring-event-page-render-and-confirm):
//     1. session/route.ts — add `recurrence: link.recurrence ?? null` to the
//        `link` object in the response.
//     2. deal-room.tsx — add `linkRecurrence` state, hydrate from
//        `data.link.recurrence` via `readRecurrence()`, pass to the adapter.
//     3. dealRoomToMeetingCardProps.ts — add `linkRecurrence` field to
//        `DealRoomConfirmedSnapshot`, implement `buildSeriesInfo()` helper,
//        spread `series` into both confirmed and proposal return shapes.
//     4. MeetingCard/types.ts — `SeriesInfo.total` becomes `total?: number`
//        (M1 directive: no session counts rendered on the card surface).
//
//   Pure-logic coverage: the transformation is unit-tested exhaustively in
//   src/__tests__/unit/deal-room-to-meeting-card-props.test.ts (the "series
//   info" describe block). Those 12 cells verify the regression: removing
//   the `buildSeriesInfo` spread from the adapter fails the "series is
//   defined when linkRecurrence is present" assertion immediately.
//
// ── Variant axis ──────────────────────────────────────────────────────────────
//
//   link-type axis: {primary, personal, bookable}
//     All three share the same dealRoomToMeetingCardProps adapter path; the
//     distinction is how `link.recurrence` reaches the DB (host-created for
//     primary/personal, inherited from office-hours rule for bookable). All
//     three must render the 🔁 cadence row when recurring.
//
//   state axis: {pre-anchor-commit, post-anchor-commit}
//     Pre-commit: guest hasn't picked the first slot yet; the 🔁 row must
//     still appear (series is known from `link.recurrence` alone).
//     Post-commit: guest confirmed; 🔁 row + cadence subtitle both appear.
//
//   Required variant cells:
//     A. personal-link + pre-commit   → 🔁 badge + "weekly · 105 min" cadence visible
//     B. personal-link + post-commit  → same + confirmed state hero
//     C. primary-link  + pre-commit   → same
//     D. primary-link  + post-commit  → same
//     E. bookable-link + pre-commit   → same (recurrence inherited from rule)
//     F. bookable-link + post-commit  → same
//
//   Regression cell: assert `data-testid="series-cadence"` or
//   `aria-label="Weekly meeting"` is VISIBLE. On the reverted fix (no
//   `recurrence` in session response), these assertions must fail with
//   "Locator not found" — proof the spec catches the original bug.
//
// ── ARIA targets ──────────────────────────────────────────────────────────────
//
//   The MeetingCardInfoBlock renders the 🔁 series row inside a `<div
//   role="region" aria-label="Meeting series">` (Phase-1 implementation per
//   MeetingCardSeriesBlock stub). The cadence text is the direct text child.
//   If markup lacks these roles, the fix PR must add them (accessibility-
//   positive per the buildtest skill instructions).
//
//   Fallback to `data-testid="series-cadence-row"` only if ARIA markup can't
//   be added in the same PR. Flag the gap in the LOG entry.
//
// ── Infrastructure needed ─────────────────────────────────────────────────────
//
//   1. **Test-user JWT mint + cookie injection** — to authenticate the host
//      browser context for link creation. No endpoint today; flag in
//      e2e/_helpers/README.md as "next infra priority after cmp4xju6z."
//   2. **Personal/primary link create via API** — `POST /api/me/links` with
//      the test-user JWT and `recurrence: { v: "1", pattern: "weekly",
//      timezone: "America/Los_Angeles", anchor: { durationMin: 105 } }` in
//      the body. Endpoint exists; helper wrapper `e2e/_helpers/createLink.ts`
//      does not yet.
//   3. **Bookable-link session spawn** — `GET /meet/<slug>/<code>` as an
//      anonymous guest creates the child session (server-side). No auth
//      needed on the GUEST side, but the bookable rule must exist under
//      the test-host account (requires #1 for setup).
//
// ── What's protecting against regressions today ───────────────────────────────
//
//   - src/__tests__/unit/deal-room-to-meeting-card-props.test.ts — 12-cell
//     matrix on the pure adapter (see "series info (cmp4xju6z)" describe block).
//     Covers all {confirmed, proposal} × {one-off, recurring, bounded} cells
//     + occurrenceIndex sub-axis. Catches the regression at the adapter level
//     the moment `buildSeriesInfo` is removed or `linkRecurrence` is not
//     threaded through.
//   - Browser-verified via Playwright MCP: manual pass against dev server
//     post-fix — navigated to /meet/johnanderson/3cqmet as anonymous guest,
//     confirmed 🔁 "weekly · 105 min" cadence row is visible in MeetingCard.
//     Transcript artifact cited in LOG.md cmp4xju6z entry.
//
// When you implement: delete the "Infrastructure needed" block above, replace
// `test.skip` with `test`, fill in the API seed calls, and assert the
// `[aria-label="Meeting series"]` element is visible. Per PLAYBOOK Rule 29:
// revert the fix on a scratch branch — all six variant cells must fail with
// "Locator not found" — then restore + confirm all pass.
//
// Reference: proposals/2026-05-14_recurring-event-page-render-and-confirm_
//   reviewed-2026-05-14_decided-2026-05-14.md (PR1).

test.skip("recurring deal-room renders 🔁 cadence row — personal link, pre-commit (cmp4xju6z variant A)", async ({
  page,
}) => {
  // TODO(infra): test-user JWT mint → e2e/_helpers/auth.ts
  // TODO(infra): POST /api/me/links with recurrence field → e2e/_helpers/createLink.ts
  // TODO: navigate to /meet/<slug>/<code> as anonymous guest (no auth needed)
  // TODO: assert [aria-label="Meeting series"] is visible
  // TODO: assert cadence text contains "weekly"
  void page;
});

test.skip("recurring deal-room renders 🔁 cadence row — personal link, post-commit (cmp4xju6z variant B)", async ({
  page,
}) => {
  // TODO(infra): same as A, plus seed an agreed session with a real agreedTime
  // TODO: assert confirmed hero is visible AND [aria-label="Meeting series"] is visible
  void page;
});

test.skip("recurring deal-room renders 🔁 cadence row — primary link, pre-commit (cmp4xju6z variant C)", async ({
  page,
}) => {
  void page;
});

test.skip("recurring deal-room renders 🔁 cadence row — primary link, post-commit (cmp4xju6z variant D)", async ({
  page,
}) => {
  void page;
});

test.skip("recurring deal-room renders 🔁 cadence row — bookable link, pre-commit (cmp4xju6z variant E)", async ({
  page,
}) => {
  // TODO(infra): bookable rule + child session spawn — guest-side visit creates
  //   the child automatically; no guest auth needed. Host-side bookable rule
  //   creation requires the JWT mint from #1.
  void page;
});

test.skip("recurring deal-room renders 🔁 cadence row — bookable link, post-commit (cmp4xju6z variant F)", async ({
  page,
}) => {
  void page;
});

test.skip("one-off deal-room does NOT render series cadence row (no false-positive)", async ({
  page,
}) => {
  // Regression guard: a non-recurring link (no recurrence field) must NOT render
  // the series cadence row. Prevents a future change from accidentally treating
  // all links as recurring.
  // TODO(infra): POST /api/me/links WITHOUT recurrence field
  // TODO: navigate + assert [aria-label="Meeting series"] is NOT in the DOM
  void page;
});
