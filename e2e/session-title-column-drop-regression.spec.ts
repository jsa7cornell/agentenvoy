import { test } from "@playwright/test";

// Regression seed for two commits that fixed `column NegotiationSession.title
// does not exist` DB errors introduced when Session.title was dropped
// (2026-05-14 PR1 steps 2-5, commit 001dc1a) but two write/read sites were
// missed.
//
// ── What broke ───────────────────────────────────────────────────────────────
//
// commit 4eae1dd — chat-precheck: include→select + drop s.title read
//
//   In channel/chat/route.ts the event-intent precheck block (fires for
//   create_link | modify_link | cancel_link | schedule | event_action intents)
//   used:
//
//     prisma.negotiationSession.findMany({
//       where: { hostId, archived: false },
//       include: {              ← no parent `select`
//         link: { select: { ... } },
//       },
//     })
//
//   `include` without a parent `select` causes Prisma to SELECT ALL scalar
//   columns of NegotiationSession — including the now-dropped `title`.
//   PostgreSQL returned: "column NegotiationSession.title does not exist".
//   The error fired on every event-intent message send (hot path).
//   Also: the mapped object still referenced `s.title` as a fallback, which
//   would have returned `undefined` silently but was dead code post-drop.
//
// commit 925cfe8 — stale title write in tools.ts + prisma generate in check
//
//   In src/lib/mcp/tools.ts, `resolveSession()` with a `bootstrap` arg was
//   still writing:
//
//     prisma.negotiationSession.create({
//       data: { ..., title: args.bootstrap.title, ... }
//     })
//
//   The `title` column no longer exists → Postgres error on every MCP
//   session-bootstrap path (external agents seeding a fresh session).
//   Additionally: `npm run check` did not run `prisma generate`, so the local
//   Prisma client still had `title` as a known field and TypeScript passed.
//   The stale write went undetected until Vercel's build ran `prisma generate`
//   and failed.
//
// ── How the check script was hardened ────────────────────────────────────────
//
// `check` was changed from:
//   tsc --noEmit && next lint
// to:
//   prisma generate && tsc --noEmit && next lint
//
// This ensures the Prisma client is regenerated from the current schema.prisma
// before TypeScript runs, so any stale field reference (read or write) that
// survived a column drop is caught locally before push.
//
// ── Variant axis ─────────────────────────────────────────────────────────────
//
// Per PLAYBOOK Rule 29, the bugs span two code paths and multiple intent
// branches:
//
//   PRECHECK PATH (4eae1dd):
//     `isEventIntent` fires for 5 intent values. Any of these sent after the
//     column drop would hit the broken `include` query. The fix must work for
//     ALL five — not just the one named in the bug report.
//
//     intent values × post-drop state:
//       A. create_link    — "set up a meeting with X"
//       B. modify_link    — "update my link for X"
//       C. cancel_link    — "cancel the link for X"
//       D. schedule       — "move my meeting with X to tomorrow"
//       E. event_action   — "reschedule / confirm / update format" cluster
//
//   MCP BOOTSTRAP PATH (925cfe8):
//     `resolveSession({ bootstrap: { title, format, duration } })` called by
//     an external MCP agent when no session exists for the link yet. One
//     variant here — the `title` field was the only stale write:
//
//       F. MCP bootstrap with title arg → session created without title field
//
// ── Why these cells catch the regression ─────────────────────────────────────
//
// PRECHECK cells A–E:
//   Revert 4eae1dd (restore `include: { link: {...} }` without parent
//   `select`). Send a message with each intent. Prisma generates:
//     SELECT "NegotiationSession"."id", ..., "NegotiationSession"."title" FROM ...
//   Postgres throws → the try block at line 880 surfaces an error → the stream
//   either returns a 500 or the catch propagates a fallback narration. In
//   either case, the envoy response is absent or is an explicit error message.
//   Assert: response contains a non-error envoy bubble within 30s.
//   Pre-revert: assert fails (error response or timeout).
//
// BOOTSTRAP cell F:
//   Revert 925cfe8 (restore `title: args.bootstrap.title` in tools.ts).
//   Trigger MCP `post_message` with a fresh link that has no existing session.
//   The `resolveSession` bootstrap path runs and tries INSERT with `title`.
//   Postgres throws → MCP action returns an error → the agent's response
//   reflects failure.
//   Assert: MCP session creation succeeds (session ID returned, no error).
//   Pre-revert: assert fails (DB error propagated as action failure).
//
// ── Infrastructure gaps (same as all specs in this suite) ───────────────────
//
// All cells are currently skipped because:
//
//   1. No test-user JWT mint endpoint. Sending event-intent messages via the
//      dashboard chat API requires a valid session cookie / Bearer token for
//      a real user with a calibrated channel. No test-user creation path
//      exists yet (see e2e/_helpers/README.md).
//
//   2. No intent-forcing mechanism in the API. The chat route runs the intent
//      classifier on the user message. To reliably land on `create_link` vs
//      `event_action` vs `cancel_link`, the test needs either:
//        a) A `userIntentHint` override param (already supported for the
//           clarifier flow — could be reused for test seeding), or
//        b) Send a message whose text unambiguously classifies to each intent.
//      Option (b) is brittle; option (a) is preferred when infra lands.
//
//   3. No MCP test harness. Cell F requires calling the MCP `post_message`
//      tool with a fresh link that has no existing session, via an authenticated
//      MCP client. The MCP endpoint is at /api/mcp and requires host auth.
//
// ── Unit-level coverage that exists today ────────────────────────────────────
//
// The `schedulingPrecheck` function (the consumer of the precheck query result)
// is tested in:
//   src/__tests__/unit/scheduling-precheck.test.ts
// but those tests pass an in-memory `activeSessions` array — they don't
// exercise the Prisma query shape. The regression lived in the query, not in
// the function.
//
// ── When you flip these from skip → test ─────────────────────────────────────
//
// For cells A–E:
//   1. Mint a test-user JWT; seed the channel with a calibrated state.
//   2. POST /api/channel/chat with { message, userIntentHint: <intent> }.
//   3. Stream the response. Assert: within 30s a JSON frame
//      `{ type: "text", content: <non-empty string> }` is received and the
//      content does NOT match the narrateFinalizeError() sentinel
//      ("Something went wrong…" / "I wasn't able to…").
//   4. Assert: no Postgres error logged (via Supabase logs API or by checking
//      the absence of a RouteError row for this channel).
//   Revert validation: restore `include: { link: {...} }` on line 882 of
//   channel/chat/route.ts. All five cells must fail (error narration or
//   timeout). Restore fix. All five cells must pass.
//
// For cell F:
//   1. Mint a test-user JWT. Create a NegotiationLink via POST /api/me/links.
//   2. Call POST /api/mcp (or the MCP endpoint) with a `post_message` tool
//      call that references the link's code AND passes bootstrap.title.
//   3. Assert: the MCP response includes a session ID and no error field.
//   Revert validation: restore `title: args.bootstrap.title` in tools.ts
//   resolveSession. Cell F must fail (session not created). Restore fix.
//   Cell F must pass.

test.skip("precheck — create_link intent succeeds after Session.title column drop (4eae1dd)", async ({ page }) => {
  void page;
  // TODO(infra-pass): test-user JWT + POST /api/channel/chat with
  // { message: "set up a 30-min call with Alex", userIntentHint: "create_link" }.
  // Stream response. Assert: text frame received within 30s, no error sentinel.
});

test.skip("precheck — modify_link intent succeeds after Session.title column drop (4eae1dd)", async ({ page }) => {
  void page;
  // TODO(infra-pass): same as above with userIntentHint: "modify_link"
  // and a message like "update my link for Alex to 45 minutes".
});

test.skip("precheck — cancel_link intent succeeds after Session.title column drop (4eae1dd)", async ({ page }) => {
  void page;
  // TODO(infra-pass): same as above with userIntentHint: "cancel_link"
  // and a message like "cancel my link for Alex".
});

test.skip("precheck — schedule intent succeeds after Session.title column drop (4eae1dd)", async ({ page }) => {
  void page;
  // TODO(infra-pass): same as above with userIntentHint: "schedule"
  // and a message like "move my meeting with Alex to tomorrow at 3pm".
  // Requires a seeded NegotiationSession in active status.
});

test.skip("precheck — event_action intent succeeds after Session.title column drop (4eae1dd)", async ({ page }) => {
  void page;
  // TODO(infra-pass): same as above with userIntentHint: "event_action"
  // and a message like "confirm the meeting with Alex". This cluster covers
  // the PR-E renamed intent path — the precheckSessions query is identical.
});

test.skip("MCP bootstrap — session create succeeds without title field (925cfe8)", async ({ page }) => {
  void page;
  // TODO(infra-pass): test-user JWT + POST /api/me/links to create a fresh
  // NegotiationLink with no existing session. Then POST /api/mcp with a
  // `post_message` tool call that includes bootstrap: { title: "Intro call",
  // format: "video", duration: 30 }. Assert: response contains a session ID,
  // no error field. The `resolveSession` bootstrap path must create the
  // session row without `title` in the INSERT statement.
  //
  // Revert 925cfe8 on a scratch branch: restore `title: args.bootstrap.title`
  // in src/lib/mcp/tools.ts resolveSession(). This cell MUST fail (Postgres
  // error on INSERT). Restore fix. Cell MUST pass.
});
