import { test } from "@playwright/test";

// Regression seed for the 2026-05-14 session's seven commits:
//
//   b12a29f — drop GENERIC_TOPICS activity instead of routing to customTitle
//             (no more literal "meeting" titles)
//   aebce99 — inject [Context · today is ...] prefix into user messages
//             (kills date hallucinations like cmp50uvuq's "May 8")
//   b1e9ceb — strip default format when guestPicks.format=true + widen
//             "Now I can see" narration patterns
//   1ad0076 — buildEventTitle em-dash topic extraction + handler uses
//             linkRulesPreIntent.format for dashboard ↔ event-page parity
//   4a93827 — guest can shrink meeting duration without host opt-in
//             (session_lock_duration added to guest allowlist + role-aware
//             policy helper)
//   c0dd4c8 — guest can change format (session_update_format in allowlist)
//   a31ef09 — persist remediation tool results to metadata (observability)
//
// ── Variant axis ────────────────────────────────────────────────────────────
//
// Per PLAYBOOK Rule 29, each commit changes behavior across a defined axis.
// The full union for this session:
//
//   PARITY (cmp51ltr5):
//     {generic-topic activity, vocab activity, em-dash composite,
//      customTitle, no-activity} × {dashboard view, event-page view}
//     → dashboard.title MUST === event-page.title (10 cells)
//
//   DATE INJECTION (cmp50uvuq):
//     {host says "tomorrow", "next Friday", "in 2 weeks", "today"} ×
//     {TZ: PST, EST, UTC} × {weekday vs weekend}
//     → resolved date matches the prefix's anchor, not training data
//
//   GUEST CAPABILITIES (cmp51ltr5):
//     {duration shrink, duration extend} × {opt-in unset, opt-in true,
//      opt-in array} × {format video→phone, phone→in-person}
//     → shrink ALWAYS succeeds; extend gates on opt-in; format change
//       always succeeds (no opt-in)
//
//   NARRATION (cmp50uvuq + cmp4ss1ip + cmp4rin7c):
//     {"Now I can see X", "Tomorrow is X", "Let me reschedule",
//      "Let me know" canonical close}
//     → first three stripped; last preserved
//
// ── Cells worth e2e coverage (when infra lands) ─────────────────────────────
//
//   A. dashboard ↔ event-page title parity, em-dash composite case:
//      Host says "set up a call with X on Y at Z" (em-dash composite).
//      Dashboard event card title and event-page Hero title must
//      render character-identical strings — both should be the topic
//      verbatim ("Y").
//
//   B. dashboard ↔ event-page title parity, vocab-call case:
//      Host says "grab 45m VC with X". Both surfaces must show
//      "VC: X + John" (call+video → VC prefix via prefixByFormat).
//
//   C. dashboard ↔ event-page title parity, generic-topic-filter case:
//      Host says "set up a meeting with X". Both surfaces drop the
//      "meeting" filler and produce "X + John" / "VC: X + John"
//      (depending on host's primary format).
//
//   D. Date injection — "tomorrow" resolves correctly:
//      Host says "grab Xm with Y tomorrow". The persisted link has
//      availability/dateRange anchored to tomorrow in the host's TZ,
//      NOT a date from the model's training data. Replay against a
//      fixed host TZ, assert link.parameters.availability date matches.
//
//   E. Guest duration shrink — succeeds without opt-in:
//      Seed a session with link.parameters.duration=45 and NO
//      guestPicks.duration. Guest types "change to 30 mins". Session
//      gets negotiatedDuration=30 + system message "✓ Duration set to
//      30 minutes (set by guest)". Pre-cmp51ltr5 this got refused with
//      the opt-in error.
//
//   F. Guest duration extend — gated on opt-in:
//      Same seed. Guest types "make it 90 mins". Refused with the
//      "guests can only shrink" message. With opt-in flipped on, same
//      request succeeds.
//
//   G. Guest format change — succeeds:
//      Seed a session with format=video. Guest types "let's make it a
//      phone call instead". format flips to phone. System message
//      confirms the change.
//
//   H. Narration "Now I can see" — stripped at post-stream:
//      Inject a fixture stream where the model emits "Now I can see
//      tomorrow's date is X. Let me know if you want to adjust."
//      Persisted message content has the "Now I can see..." sentence
//      stripped, "Let me know..." preserved.
//
//   I. Remediation observability:
//      Seed a self-check-failing turn that triggers remediation. The
//      persisted ChannelMessage.metadata.remediationActionResults
//      includes the tool calls + their data blobs from the remediation
//      pass. Pre-a31ef09 these were dropped silently.
//
// ── Why this is skipped today ────────────────────────────────────────────────
//
// Same infrastructure gaps as e2e/primary-link-guest-name.spec.ts +
// e2e/dealroom-reschedule-clears-confirmed-card.spec.ts:
//
//   1. No test-user JWT mint endpoint. Per e2e/_helpers/README.md, this
//      is the canonical "future need" item.
//   2. No agreed-session seeder. Cells E/F/G need an agreed session with
//      a calendarEventId for session_update_*/session_lock_* to act on;
//      to reach `status: agreed` we need real GCal integration or a
//      test-only seed endpoint (the README option that "requires a
//      follow-up proposal").
//   3. No fixture-stream injection for the runner. Cell H wants to mock
//      streamText with a known leak; the unit test
//      `src/__tests__/unit/unified-agent/runner-narration-leak.test.ts`
//      already covers this at the runner level — an e2e variant would
//      duplicate without adding signal.
//
// ── What's covered TODAY (unit level) ───────────────────────────────────────
//
// Each fix is locked at the helper level — the variant matrices live in:
//
//   src/__tests__/unit/build-event-title.test.ts             (parity + em-dash)
//   src/__tests__/unit/activity-vocab.test.ts                (format-aware emoji)
//   src/__tests__/unit/deal-room-to-meeting-card-props.test.ts (renderer parity)
//   src/__tests__/unit/post-stream-checks.test.ts            (narration patterns)
//   src/__tests__/unit/unified-agent/date-context-prefix.test.ts (date injection)
//   src/__tests__/unit/session-duration-policy.test.ts       (shrink/extend matrix)
//   src/__tests__/unit/unified-agent/runner-narration-leak.test.ts (truncation)
//   src/__tests__/unit/unified-agent/runner-remediation-persistence.test.ts
//                                                            (observability — a31ef09)
//
// Combined cell count: ~80 cells across the helpers. The parity invariant
// in particular is locked: cells in deal-room-to-meeting-card-props.test.ts
// assert that the renderer's output for activity:"call" + format:"video"
// is "VC: Calle + John" — identical to what session.title (computed by
// the same helper at write time) will store.
//
// ── When you flip these from skip → test ────────────────────────────────────
//
// Per PLAYBOOK Rule 29 step 5 ("Validate the spec actually catches the
// bug"): for EACH cell A–I, on a scratch branch revert the corresponding
// commit (b12a29f / aebce99 / b1e9ceb / 1ad0076 / 4a93827 / c0dd4c8 /
// a31ef09) and confirm the spec fails. Then restore and confirm it
// passes. A spec that passes on both sides catches nothing.

test.skip("dashboard ↔ event-page title parity, em-dash composite case (1ad0076)", async ({ page }) => {
  void page;
  // TODO(infra-pass): API-seed a personal link with activity = "call —
  // Q3 review" via POST /api/me/links (test-user JWT). Open
  // /meet/<slug>/<code> as host AND in a separate context as guest.
  // Assert both surfaces' Hero title element shows "Q3 review" verbatim.
});

test.skip("dashboard ↔ event-page title parity, vocab-call case (1ad0076 + cmp4u*)", async ({ page }) => {
  void page;
  // TODO(infra-pass): API-seed activity = "call" + format = "video". Both
  // surfaces must render "VC: X + John" via prefixByFormat override.
});

test.skip("dashboard ↔ event-page title parity, generic-topic-filter case (b12a29f)", async ({ page }) => {
  void page;
  // TODO(infra-pass): API-seed activity = "meeting" (a GENERIC_TOPIC).
  // Handler drops to null. Both surfaces show "X + John" (no "meeting"
  // literal).
});

test.skip("date injection — host says 'tomorrow' resolves to host-TZ tomorrow (aebce99)", async ({ page }) => {
  void page;
  // TODO(infra-pass): test-user JWT + host with timezone set. Send chat
  // "grab 30m w/ X tomorrow". The created link's
  // parameters.availability[].days OR autoConfirm.dateTime must
  // correspond to today+1 in the host's TZ — not whatever Anthropic's
  // training-data "tomorrow" guesses.
});

test.skip("guest duration shrink — succeeds without opt-in (4a93827)", async ({ page }) => {
  void page;
  // TODO(infra-pass): seed an agreed session with link.parameters
  // .duration=45 and NO guestPicks.duration. Open as guest. Send chat
  // "change to 30 mins". Assert session.negotiatedDuration === 30 +
  // system message present.
});

test.skip("guest duration extend — refused without opt-in (4a93827)", async ({ page }) => {
  void page;
  // Sibling cell to shrink. Send "make it 90 mins" on the same seed.
  // Assert refused; session.negotiatedDuration is unchanged.
});

test.skip("guest format change — video → phone (c0dd4c8)", async ({ page }) => {
  void page;
  // TODO(infra-pass): seed an agreed session with format=video. Send
  // "let's make it a phone call instead". Assert session
  // .negotiatedFormat OR link.parameters.format flips to phone +
  // system message.
});

test.skip("remediation observability — full tool results persisted (a31ef09)", async ({ page }) => {
  void page;
  // TODO(infra-pass): inject a fixture stream where self-check fails →
  // remediation calls LOAD_calendar_context + a write tool. Query
  // ChannelMessage.metadata.remediationActionResults — must contain
  // both tool results with their full `data` blobs. Pre-a31ef09 this
  // field didn't exist.
});
