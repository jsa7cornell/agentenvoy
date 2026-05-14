import { test } from "@playwright/test";

// Regression seed for PR2 of proposals/2026-05-14_event-record-alignment
// (commit 4bb67e5).
//
// ── What PR2 changed ─────────────────────────────────────────────────────────
//
// Before PR2, LinkCard in feed.tsx received only the frozen snapshot written
// at link-creation time (`linkCardMeta` / `bookableMeta` keys). Editing a
// link's title, schedule, or format after the feed message was created had
// no effect on the rendered card — the card stayed stale until either a new
// link was created or the page was hard-refreshed and a new message was
// written.
//
// PR2 adds:
//   - GET /api/me/links/live?codes=…  — batch endpoint that returns current
//     NegotiationLink (personal/group) or structuredRules (bookable) data for
//     up to 50 link codes.
//   - feed.tsx: `liveLinkMeta` state + useEffect that collects codes from
//     messages with metadata.linkKind set, batch-fetches the live endpoint,
//     and passes live data to LinkCard as the highest-priority source.
//   - dispatch-stream.ts + runner.ts: `linkCardMeta` / `bookableMeta` renamed
//     to `linkCardMetaAtCreation` — makes the frozen nature explicit and
//     establishes a stable key for the legacy-fallback chain.
//
// ── Variant axis ─────────────────────────────────────────────────────────────
//
// Per PLAYBOOK Rule 29, the fix's behavioral change spans:
//
//   LINK KIND × EDIT-AFTER-CREATE
//
//   Link kind axis: {bookable, personal, group}
//     Three distinct producers of `linkCardMetaAtCreation` (runner.ts for
//     bookable, dispatch-stream.ts for personal/group) AND three distinct
//     read paths in the live endpoint (structuredRules vs NegotiationLink).
//     Each must be exercised independently.
//
//   Edit-after-create axis: {unchanged, title-edited}
//     On `unchanged`: card shows creation-time meta (both before and after
//     PR2 — this cell is a non-regression check that the live fetch doesn't
//     clobber valid creation-time data).
//     On `title-edited`: card MUST reflect the updated title WITHOUT a page
//     reload (new behavior post-PR2). On reverted feed.tsx, this cell fails
//     because `liveLinkMeta` never gets populated — the card keeps showing
//     the old `linkCardMetaAtCreation` title.
//
//   Legacy-fallback axis: {linkCardMetaAtCreation key, linkCardMeta key, bookableMeta key}
//     Rows written before PR2 carry `linkCardMeta` or `bookableMeta` as the
//     frozen snapshot key. The fallback chain in feed.tsx must render these
//     correctly even when the live fetch returns no data for the code
//     (e.g., the link was deleted after the message was written).
//
// Full cell matrix (6 live-edit cells + 3 unchanged cells + 3 legacy cells):
//
//   A. bookable × unchanged    — card shows creation-time name; live fetch is a no-op
//   B. bookable × title-edited — after editing rule.bookable.name, card shows new name
//   C. personal × unchanged    — card shows creation-time customTitle; no-op live fetch
//   D. personal × title-edited — after editing link.customTitle, card shows new title
//   E. group    × unchanged    — same as C with a group link
//   F. group    × title-edited — same as D with a group link
//   G. legacy bookableMeta key — message with old key still renders card (fallback chain)
//   H. legacy linkCardMeta key — message with intermediate key still renders card
//   I. code not found by live endpoint — card gracefully falls back to linkCardMetaAtCreation
//
// ── Why this catches the pre-PR2 regression ──────────────────────────────────
//
// Cells B, D, F are the regression cells. To validate:
//   1. On a scratch branch, revert the feed.tsx changes from commit 4bb67e5
//      (remove the `liveLinkMeta` state + useEffect + the liveLinkMeta lookup
//      in the LinkCard `meta` prop).
//   2. Run cells B/D/F — they MUST fail because the card still shows the
//      pre-edit title from the frozen `linkCardMetaAtCreation` snapshot.
//   3. Restore the revert. Re-run — all cells must pass.
//
// Cells G/H/I validate backward-compat (the renamed key doesn't break
// legacy rows). On revert, G/H would fail if the fallback chain was also
// changed; I tests the "live fetch returns nothing" graceful path.
//
// ── Infrastructure gaps (same as other specs in this suite) ──────────────────
//
// All cells are currently skipped because:
//
//   1. No test-user JWT mint endpoint. API-only seeding (per e2e/_helpers/README.md)
//      requires POSTing to /api/me/links + /api/channel/chat with a test-user
//      Bearer token. No test-user creation endpoint exists yet.
//
//   2. No host-chat seeder that generates a real linkKind=bookable message.
//      Creating a bookable link via chat requires a full agent turn (the host
//      sends "set up a weekly coffee chat" and the runner calls
//      create_bookable_link). There's no direct POST endpoint that produces a
//      ChannelMessage with metadata.linkKind=bookable + metadata.linkUrl set.
//      Options when infra lands:
//        a) POST to /api/channel/chat as the test user; await the streamed turn;
//           parse the metadata from the resulting ChannelMessage.
//        b) A test-only seed endpoint that writes a synthetic ChannelMessage
//           (visible at code review; needs a follow-up proposal per README).
//      Option (a) is preferred — it exercises the real agent path.
//
//   3. No link-edit endpoint tested in the harness. Editing a bookable link's
//      name requires POSTing to the host-MCP endpoint `modify_link` or to
//      a preferences update endpoint that writes structuredRules. A personal
//      link title edit goes through PUT /api/me/links/:code or the MCP
//      tool. Neither has been used in existing e2e specs.
//
// ── What's covered at unit level ─────────────────────────────────────────────
//
// The three-key fallback chain (liveLinkMeta > linkCardMetaAtCreation >
// linkCardMeta > bookableMeta) and the extractLinkCode helper are pure
// functions; they can be covered by vitest unit tests when the unit-test
// pass for PR2 is authored (scoped as a follow-up per the proposal).
//
// The live endpoint's NegotiationLink vs structuredRules dispatch is covered
// indirectly by route tests (vitest HTTP suite) once the test-user JWT is
// available.
//
// ── When you flip these from skip → test ─────────────────────────────────────
//
// For each cell:
//   1. Implement the seed (test-user JWT + API call chain).
//   2. Navigate to the feed; wait for the linkCard with role="article" or
//      a stable data-testid (ARIA audit: LinkCard currently lacks an
//      accessible name — add aria-label={`${kind} scheduling link`} in the
//      same PR per Rule 29 § ARIA audit).
//   3. For edit cells: POST to the edit endpoint; wait for the next
//      liveLinkMeta fetch cycle (the useEffect fires on messages change —
//      trigger a page poll or send a no-op message to refresh messages, then
//      wait for the card title to update).
//   4. Assert the card's title text matches the edited value.
//   5. Run with the revert applied (step from "Why this catches the regression"
//      above) to confirm the cell fails.

test.skip("bookable link × unchanged — card shows creation-time name (4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): test-user JWT + POST /api/channel/chat "set up a
  // weekly coffee chat". Await streamed turn. Find the ChannelMessage with
  // metadata.linkKind === "bookable". Navigate to feed. Assert:
  //   - LinkCard visible with the rule's bookable.name as title text.
  //   - No edit applied; live fetch is a pass-through (data matches creation).
});

test.skip("bookable link × title-edited — card reflects updated name after rule edit (4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): same seed as above (bookable link created via chat).
  // Then: PATCH to the host-MCP modify_link endpoint OR PUT to the
  // preferences structuredRules update endpoint, changing rule.bookable.name
  // to "Updated Coffee Chat". Trigger a messages refresh (no page reload).
  // Assert: LinkCard title text === "Updated Coffee Chat".
  //   Pre-PR2 revert: card still shows original name (frozen snapshot).
});

test.skip("personal link × unchanged — card shows creation-time customTitle (4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): POST /api/me/links with {inviteeName, customTitle, ...}
  // as test user. Seed a ChannelMessage with metadata.linkKind="personal" +
  // metadata.linkUrl pointing to the link. Navigate to feed. Assert:
  //   - LinkCard shows customTitle as title.
});

test.skip("personal link × title-edited — card reflects updated customTitle (4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): same personal-link seed. Then: PUT to update endpoint
  // setting link.customTitle = "Updated Personal Title". Trigger messages
  // refresh. Assert: card title === "Updated Personal Title".
  //   Pre-PR2 revert: card still shows original customTitle.
});

test.skip("group link × unchanged — card shows creation-time group name (4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): seed a group link (inviteeNames: [...]) via API.
  // Assert card renders with the group's customTitle or inviteeNames join.
});

test.skip("group link × title-edited — card reflects updated customTitle (4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): edit group link's customTitle. Assert card updates.
  //   Pre-PR2 revert: card stays stale.
});

test.skip("legacy bookableMeta key — feed still renders card (fallback chain, 4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): seed a synthetic ChannelMessage (test-only endpoint or
  // option b from infra gap §2) with metadata = { linkKind: "bookable",
  // linkUrl: "/meet/slug/code", bookableMeta: { title: "Legacy Title" } }
  // (NO linkCardMetaAtCreation key). Navigate to feed. Assert:
  //   - LinkCard renders with "Legacy Title" (bookableMeta fallback fires).
  //   Pre-PR2 revert of the fallback chain: card renders nothing (meta=undefined).
});

test.skip("legacy linkCardMeta key — feed still renders card (fallback chain, 4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): same as above but with key = linkCardMeta (intermediate
  // rename). Assert card renders correctly via the middle fallback slot.
});

test.skip("link code not found by live endpoint — falls back to linkCardMetaAtCreation (4bb67e5)", async ({ page }) => {
  void page;
  // TODO(infra-pass): seed a ChannelMessage with a linkCode that no longer
  // exists in NegotiationLink (e.g., the link was deleted after the message
  // was written). The live endpoint returns {} for that code. Assert:
  //   - Card renders using linkCardMetaAtCreation (the frozen snapshot is
  //     the correct graceful fallback for deleted links).
  //   - No JavaScript error or blank card.
});
