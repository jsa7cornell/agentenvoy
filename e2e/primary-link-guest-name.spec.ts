import { test } from "@playwright/test";

// Canonical regression seed for cmp451sli (2026-05-13 LOG):
//   On a *primary* link (not personal), the original guest-name fix's client fallback
//   chain referenced `data.session?.guestName`, but the server response had no `session`
//   key. The fix silently fell through to the "G" sentinel on exactly the path it was
//   named for. A real e2e test that creates a primary link, has a guest submit a name
//   via the picker, and asserts the rendered card shows that name (not "G") would have
//   caught this immediately.
//
// Assertion this scenario WILL make once fleshed out:
//   - Create a primary link via the create-link API (POST with test-user JWT)
//   - Open the link as an anonymous "guest" browser context
//   - Submit a guest name through the picker
//   - Confirm
//   - Switch to the host view of the resulting deal-room
//   - Assert: the rendered MeetingCard shows the guest's submitted name,
//     NOT the "G" sentinel
//
// Why this is skipped today:
//   Authoring the full spec requires (a) the create-link API endpoint shape + test-user
//   JWT mint path, and (b) stable ARIA roles / accessible names on the picker. The
//   proposal commits to an ARIA audit before authoring (industry-research finding in
//   the review). Both are scoped for the next implementation pass on this Layer 1.
//
// When you implement: replace `test.skip` with `test`, delete this banner, and make
// the assertion fail (revert cmp451sli's fix on a scratch branch) before it passes —
// the regression seed must actually catch the original bug. See proposal §6 step 3.

test.skip("primary-link guest name renders on host's deal-room card (cmp451sli)", async ({
  page,
}) => {
  // TODO(next-pass): API-only seed via POST /api/.../create-link with test-user JWT.
  //   Helper goes in e2e/_helpers/createPrimaryLink.ts.
  // TODO(next-pass): open as guest, submit name through picker, confirm.
  // TODO(next-pass): switch to host view, assert MeetingCard text.
  //   File: src/components/deal-room/dealRoomToMeetingCardProps.ts:118 is the relevant
  //   `inviteeName` consumer for the assertion.
});
