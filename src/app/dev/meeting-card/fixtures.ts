/**
 * Fixtures for the /dev/meeting-card harness.
 *
 * Each fixture is a fully-formed MeetingCardProps covering a distinct
 * R3/R4/R5 mockup state. Use these to exercise all rendering branches without
 * a live backend.
 *
 * Fixture naming convention: [channel][ViewerRole?][state][series?]
 * e.g. singleInPersonGuest, singlePhoneHost, recurringConfirmedGuest
 *
 * 2026-05-09: Added 6 GCal-status fixtures for § 3.14 / § 12 of spec.
 */

import type { MeetingCardProps, SeriesPageProps } from "@/components/MeetingCard/types";

// ── Shared participants ───────────────────────────────────────────────────────

const HOST = {
  firstName: "John",
  lastName: "Anderson",
  avatarSeed: "john-anderson",
};

const GUEST = {
  firstName: "Sarah",
  lastName: "Chen",
  avatarSeed: "sarah-chen",
};

// ── Shared when blocks ────────────────────────────────────────────────────────

const SINGLE_WHEN = {
  time: new Date("2026-05-19T16:30:00Z"), // 9:30 AM PDT / 12:30 PM EDT
  tz: "America/Los_Angeles",
  otherTz: "America/New_York",
  durationMin: 30,
};

const RECURRING_WHEN = {
  time: new Date("2026-05-21T23:00:00Z"), // 4 PM PDT / 7 PM EDT
  tz: "America/Los_Angeles",
  otherTz: "America/New_York",
  durationMin: 60,
};

const SERIES = {
  cadence: "Weekly on Wednesdays at 4:00 PM",
  cadenceShort: "Weekly piano",
  span: "Started Mar 8 · ends Aug 15",
  position: 11,
  total: 24,
  nextSessionDate: new Date("2026-05-28T23:00:00Z"),
  seriesUrl: "/john/piano-lesson/series",
};

const TIP = {
  text: "John runs his Tuesday/Wednesday sessions from Sightglass in SoMa — great coffee and reliable wifi if you're ever in SF.",
};

// ── GCal event URL (shared across GCal fixtures) ──────────────────────────────

const GCAL_EVENT_URL = "https://www.google.com/calendar/event?eid=abc123";

// ── Single-session fixtures ───────────────────────────────────────────────────

/**
 * Single in-person meeting — guest view, proposal state.
 * Baseline fixture: no tip, no series, calendar disconnected.
 */
export const singleInPersonGuest: MeetingCardProps = {
  viewerRole: "guest",
  state: "proposal",
  host: HOST,
  guest: GUEST,
  title: "Coffee with John",
  when: SINGLE_WHEN,
  channel: {
    kind: "in-person",
    location: "Sightglass Coffee · 270 7th St, San Francisco",
  },
};

/**
 * Single video meeting — guest view, proposal state + tip.
 */
export const singleVideoGuest: MeetingCardProps = {
  viewerRole: "guest",
  state: "proposal",
  host: HOST,
  guest: GUEST,
  title: "Q2 Roadmap Review",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
    joinUrl: "https://zoom.us/j/123456789",
  },
  tip: TIP,
};

/**
 * Single phone meeting — guest view, confirmed state.
 * "John will call you at (415) 867-5309" — Design X: renderer composes from signals.
 */
export const singlePhoneGuest: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "phone",
    phoneNumber: "(415) 867-5309",
    hostCallsGuest: true,
  },
  tip: { text: "Heads up: John is calling from a 415 number you may not recognize." },
};

/**
 * Single phone meeting — HOST view, confirmed state.
 * Same channel data, different viewer — renderer composes "Call Sarah at..."
 * Demonstrates Design X: MeetingCardInfoBlock renders asymmetric copy from
 * the same role-agnostic ChannelInfo.
 */
export const singlePhoneHost: MeetingCardProps = {
  viewerRole: "host",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "phone",
    phoneNumber: "(415) 867-5309",
    hostCallsGuest: true,
  },
};

/**
 * Matched state — calendar overlap detected, best-fit hero surfaced.
 * Sky→indigo accent per R3.
 */
export const singleVideoMatched: MeetingCardProps = {
  viewerRole: "guest",
  state: "matched",
  host: HOST,
  guest: GUEST,
  title: "Strategy Session",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Google Meet",
  },
  tip: { text: "You and John both have Tuesday 9:30 open — rare overlap for a Thursday-heavy week." },
};

/**
 * Confirming state — slot selected, confirm request in flight.
 */
export const singleVideoConfirming: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirming",
  host: HOST,
  guest: GUEST,
  title: "Q2 Roadmap Review",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
  },
};

// ── Recurring session fixtures ─────────────────────────────────────────────

/**
 * Recurring confirmed — guest view, mid-series.
 * Emerald accent. Action set: Reschedule this · Skip this · ⋯
 */
export const recurringConfirmedGuest: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Leadership Coaching",
  when: RECURRING_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
    joinUrl: "https://zoom.us/j/987654321",
  },
  tip: { text: "Session 11 of 24 — you're nearly halfway through the series. John typically starts with a 5-min check-in before the main agenda." },
  series: SERIES,
};

/**
 * Recurring skipped — amber accent, ⤫ glyph, "Undo skip" promoted to primary.
 */
export const recurringSkippedGuest: MeetingCardProps = {
  viewerRole: "guest",
  state: "skipped",
  host: HOST,
  guest: GUEST,
  title: "Leadership Coaching",
  when: {
    ...RECURRING_WHEN,
    time: new Date("2026-05-21T23:00:00Z"),
  },
  channel: {
    kind: "video",
    platform: "Zoom",
  },
  series: {
    ...SERIES,
    position: 11,
  },
};

// ── Deal-room R3 layout states (for proposal/picker view) ─────────────────

/**
 * Anonymous proposal — no guest name (primary link).
 */
export const anonymousProposal: MeetingCardProps = {
  viewerRole: "guest",
  state: "proposal",
  host: HOST,
  guest: { firstName: "You" },
  title: "Office Hours with John",
  when: {
    time: new Date("2026-05-19T17:00:00Z"),
    tz: "America/Los_Angeles",
    durationMin: 30,
  },
  channel: {
    kind: "video",
    platform: "Google Meet",
  },
  tip: { text: "John holds Office Hours every Tuesday morning — drop in for any quick question or intro conversation." },
};

/**
 * Proposal state with calendar disconnected — exercises MeetingCardPickerHost disconnected bar.
 */
export const proposalDisconnected: MeetingCardProps = {
  viewerRole: "guest",
  state: "proposal",
  host: HOST,
  guest: GUEST,
  title: "Coffee with John",
  when: SINGLE_WHEN,
  channel: {
    kind: "in-person",
    location: "Sightglass Coffee · 270 7th St, San Francisco",
  },
  calendar: { connected: false },
};

/**
 * Proposal state with calendar connected — exercises MeetingCardPickerHost connected bar.
 */
export const proposalConnected: MeetingCardProps = {
  viewerRole: "guest",
  state: "proposal",
  host: HOST,
  guest: GUEST,
  title: "Coffee with John",
  when: SINGLE_WHEN,
  channel: {
    kind: "in-person",
    location: "Sightglass Coffee · 270 7th St, San Francisco",
  },
  calendar: { connected: true, email: "sarah.chen@gmail.com" },
};

/**
 * Desktop example — confirmed, phone, guest view.
 */
export const desktopExample: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "phone",
    phoneNumber: "(415) 867-5309",
    hostCallsGuest: true,
  },
  tip: { text: "Heads up: John is calling from a 415 number you may not recognize." },
};

// ── GCal status fixtures (§ 3.14 / § 12) ─────────────────────────────────────

/**
 * Registered guest, no GCal connected.
 * CalendarRow shows: "Calendar not connected · Connect →"
 * Calendar action (slot 1): "Add to calendar"
 */
export const singleGuestNoGCal: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
    joinUrl: "https://zoom.us/j/123456789",
  },
  googleCalendar: {
    eventUrl: GCAL_EVENT_URL,
    viewerStatus: null,
    connectPromptEligible: true,
  },
};

/**
 * Registered guest, GCal connected, invite pending.
 * CalendarRow shows: "Google Calendar · Awaiting RSVP" (amber pill)
 * Calendar action (slot 1): "Accept in Google Calendar"
 */
export const singleGuestPending: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
    joinUrl: "https://zoom.us/j/123456789",
  },
  googleCalendar: {
    eventUrl: GCAL_EVENT_URL,
    viewerStatus: "needsAction",
    connectPromptEligible: false,
  },
};

/**
 * Registered guest, accepted.
 * CalendarRow shows: "Google Calendar · Accepted ✓" (emerald pill)
 * Calendar action (slot 1): "Open in Google Calendar"
 */
export const singleGuestAccepted: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
    joinUrl: "https://zoom.us/j/123456789",
  },
  googleCalendar: {
    eventUrl: GCAL_EVENT_URL,
    viewerStatus: "accepted",
    connectPromptEligible: false,
  },
};

/**
 * Registered guest, tentative.
 * CalendarRow shows: "Google Calendar · Maybe" (amber pill)
 * Calendar action (slot 1): "Confirm in Google Calendar"
 */
export const singleGuestTentative: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
    joinUrl: "https://zoom.us/j/123456789",
  },
  googleCalendar: {
    eventUrl: GCAL_EVENT_URL,
    viewerStatus: "tentative",
    connectPromptEligible: false,
  },
};

/**
 * Registered guest, declined.
 * CalendarRow shows: "Google Calendar · Declined" (rose pill)
 * Calendar action (slot 1): "Re-accept in Google Calendar"
 */
export const singleGuestDeclined: MeetingCardProps = {
  viewerRole: "guest",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
    joinUrl: "https://zoom.us/j/123456789",
  },
  googleCalendar: {
    eventUrl: GCAL_EVENT_URL,
    viewerStatus: "declined",
    connectPromptEligible: false,
  },
};

/**
 * Host view — otherPartyStatus: "needsAction" with stale invite (>24h).
 * CalendarRow shows: "Sarah's RSVP · Awaiting response" + "Invite sent Nh ago"
 * "Nudge Sarah" affordance (stale = inviteSentAt > 24h ago).
 * Calendar action (slot 1): "Open in Google Calendar" (host always has Open)
 */
export const singleHostView: MeetingCardProps = {
  viewerRole: "host",
  state: "confirmed",
  host: HOST,
  guest: GUEST,
  title: "Intro Call",
  when: SINGLE_WHEN,
  channel: {
    kind: "video",
    platform: "Zoom",
    joinUrl: "https://zoom.us/j/123456789",
  },
  googleCalendar: {
    eventUrl: GCAL_EVENT_URL,
    viewerStatus: null,
    otherPartyStatus: "needsAction",
    // stale: set 30 hours ago to trigger "Nudge" affordance
    inviteSentAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    connectPromptEligible: false,
  },
};

// ── guestPicks format-deferred fixtures (cmp5sm07o) ─────────────────────────

export const guestPicksFormatGuest: MeetingCardProps = {
  viewerRole: "guest",
  state: "proposal",
  host: HOST,
  guest: GUEST,
  title: "Hang with John",
  when: SINGLE_WHEN,
  channel: { kind: "TBD" },
  tip: { text: "John'd love your call on the format — video, phone, or in-person?" },
};

export const guestPicksFormatHost: MeetingCardProps = {
  viewerRole: "host",
  state: "proposal",
  host: HOST,
  guest: GUEST,
  title: "Hang with Sarah",
  when: SINGLE_WHEN,
  channel: { kind: "TBD" },
  tip: { text: "Sarah picks the format — they'll confirm video, phone, or in-person." },
};

/** All fixtures collected for iteration in the dev harness. */
export const ALL_FIXTURES: Array<{ label: string; props: MeetingCardProps }> = [
  { label: "Single · In-person · Guest · Proposal", props: singleInPersonGuest },
  { label: "Single · Video · Guest · Proposal + Tip", props: singleVideoGuest },
  { label: "Single · Video · Guest · Matched", props: singleVideoMatched },
  { label: "Single · Video · Guest · Confirming", props: singleVideoConfirming },
  { label: "Single · Phone · Guest · Confirmed", props: singlePhoneGuest },
  { label: "Single · Phone · HOST · Confirmed (Design X)", props: singlePhoneHost },
  { label: "Recurring · Video · Guest · Confirmed + Series", props: recurringConfirmedGuest },
  { label: "Recurring · Video · Guest · Skipped + Series", props: recurringSkippedGuest },
  { label: "Anonymous · Video · Guest · Proposal", props: anonymousProposal },
  { label: "Proposal · In-person · Calendar disconnected", props: proposalDisconnected },
  { label: "Proposal · In-person · Calendar connected", props: proposalConnected },
  { label: "Desktop · Phone · Guest · Confirmed", props: desktopExample },
  // GCal status states (§ 3.14)
  { label: "GCal · Guest · No GCal connected (Connect prompt)", props: singleGuestNoGCal },
  { label: "GCal · Guest · Pending (needsAction)", props: singleGuestPending },
  { label: "GCal · Guest · Accepted", props: singleGuestAccepted },
  { label: "GCal · Guest · Tentative", props: singleGuestTentative },
  { label: "GCal · Guest · Declined", props: singleGuestDeclined },
  { label: "GCal · Host view · Guest pending (stale + Nudge)", props: singleHostView },
  // guestPicks format-deferred (cmp5sm07o)
  { label: "TBD · Guest picks format · Guest view", props: guestPicksFormatGuest },
  { label: "TBD · Guest picks format · Host view", props: guestPicksFormatHost },
];

// ── SeriesPage fixture ────────────────────────────────────────────────────────

/**
 * seriesPageExample — fixture for the SeriesPage component dev harness section.
 * Piano lesson series: weekly on Wednesdays · 6 upcoming sessions with all 4 statuses.
 *
 * Dates are UTC midnight + 23h so they land at 4 PM PDT (UTC-7) on the correct
 * Wednesday in the viewer's timezone.
 */
export const seriesPageExample: SeriesPageProps = {
  host:  { firstName: "Maya", lastName: "Patel" },
  guest: { firstName: "Sarah", lastName: "Chen" },
  title:   "Weekly piano lesson",
  cadence: "Wednesdays at 4:00 PM (PDT) · with Maya",
  googleCalendarSeriesUrl: "https://calendar.google.com/calendar/r/eventedit",
  upcoming: [
    { sessionId: "s12", position: 12, date: new Date("2026-05-12T23:00:00Z"), tz: "America/Los_Angeles", durationMin: 30, status: "next",      channel: { kind: "in-person", location: "Lakeside Studio" }, url: "/maya/piano/session-12" },
    { sessionId: "s13", position: 13, date: new Date("2026-05-19T23:00:00Z"), tz: "America/Los_Angeles", durationMin: 30, status: "confirmed", channel: { kind: "in-person", location: "Lakeside Studio" }, url: "/maya/piano/session-13" },
    { sessionId: "s14", position: 14, date: new Date("2026-05-26T23:00:00Z"), tz: "America/Los_Angeles", durationMin: 30, status: "skipped",   channel: { kind: "in-person", location: "Lakeside Studio" }, skipReason: "Sarah out of town", url: "/maya/piano/session-14" },
    { sessionId: "s15", position: 15, date: new Date("2026-06-02T23:00:00Z"), tz: "America/Los_Angeles", durationMin: 30, status: "confirmed", channel: { kind: "in-person", location: "Lakeside Studio" }, url: "/maya/piano/session-15" },
    { sessionId: "s16", position: 16, date: new Date("2026-06-09T23:00:00Z"), tz: "America/Los_Angeles", durationMin: 30, status: "confirmed", channel: { kind: "in-person", location: "Lakeside Studio" }, url: "/maya/piano/session-16" },
    { sessionId: "s17", position: 17, date: new Date("2026-06-16T23:00:00Z"), tz: "America/Los_Angeles", durationMin: 30, status: "confirmed", channel: { kind: "in-person", location: "Lakeside Studio" }, url: "/maya/piano/session-17" },
  ],
};
