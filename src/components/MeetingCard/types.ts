/**
 * Shared TypeScript types for the MeetingCard component family.
 *
 * All types in this file — none scattered across component files.
 * See proposal 2026-05-08 §2 for architecture rationale.
 *
 * Design X: ChannelInfo carries role-agnostic structured signals.
 * Renderers compose viewer-specific copy (e.g. "John will call you"
 * vs "You'll call Sarah") from the data — nothing pre-rendered on
 * the MCP wire. Continues the AP5 pattern (signals not renders).
 *
 * Phase 1 tip shape: `{ text: string }` only — no source field.
 * Source labels land in Phase 2 with the real tip generator.
 * See proposal 2026-05-08 §2.2, B1 resolution.
 */

// ── Roles & Enumerations ────────────────────────────────────────────────────

/**
 * Which side of the meeting the current viewer is on.
 * Renderers use this to compose viewer-specific copy from role-agnostic
 * structured data (Design X from proposal 2026-05-08 §Agent-platform).
 */
export type ViewerRole = "guest" | "host";

/**
 * Meeting channel — how participants will connect.
 * Drives the channel-line display in MeetingCardInfoBlock.
 */
export type ChannelKind = "in-person" | "video" | "phone";

/**
 * Card state — which phase the scheduling negotiation is in.
 * Controls which blocks render and which CTAs are active.
 *
 * - proposal: no slot selected yet; picker is shown
 * - matched: calendar overlap found; best-fit hero surfaced
 * - confirming: slot selected, confirm request in flight (~1.2s transition)
 * - confirmed: booking locked; action grid shown, picker hidden
 * - skipped: recurring session skipped; amber accent, "Undo skip" promoted
 */
export type MeetingCardState =
  | "proposal"
  | "matched"
  | "confirming"
  | "confirmed"
  | "skipped";

// ── Channel ─────────────────────────────────────────────────────────────────

/**
 * In-person channel — physical location meeting.
 * `location` is a human-readable address or venue name.
 *
 * `guestPicks`: when true, the host deferred venue selection to the guest.
 * Renderer must surface it as an explicit affordance — NOT default to "TBD".
 * `location` will be an empty string in this case; the renderer should ignore
 * it and show the deferral copy instead.
 */
export interface InPersonChannel {
  kind: "in-person";
  location: string;
  /** When true, the host deferred venue selection to the guest. */
  guestPicks?: boolean;
}

/**
 * Video channel — virtual meeting with a join link.
 * `platform` is display name (e.g. "Zoom", "Google Meet").
 * `joinUrl` opens the call; optional because it may not be set until confirmed.
 */
export interface VideoChannel {
  kind: "video";
  platform: string;
  joinUrl?: string;
}

/**
 * Phone channel — one party calls the other.
 * Design X: renderer composes the viewer-specific sentence
 * ("John will call you" / "You'll call Sarah") from these signals.
 * Never pre-rendered on the MCP wire.
 *
 * `hostCallsGuest: true` is not optional — it is always true in Phase 1
 * per the R4 confirmed-card design lock (2026-05-08). If guest-calls-host
 * is ever supported, a discriminated sub-variant should be added here.
 */
export interface PhoneChannel {
  kind: "phone";
  /** Guest's phone number — displayed to both sides. */
  phoneNumber: string;
  /** Always true: host initiates the call. */
  hostCallsGuest: true;
}

/**
 * Discriminated union of all channel variants.
 * Narrow via `channel.kind` before reading channel-specific fields.
 */
export type ChannelInfo = InPersonChannel | VideoChannel | PhoneChannel;

// ── Participants ─────────────────────────────────────────────────────────────

/**
 * A meeting participant — host or guest.
 * `avatarSeed` is an optional stable string for deterministic avatar generation
 * (e.g. DiceBear seed). If absent, fall back to initials.
 */
export interface Participant {
  firstName: string;
  lastName?: string;
  /** Optional stable string for deterministic avatar rendering. */
  avatarSeed?: string;
}

// ── Tip ─────────────────────────────────────────────────────────────────────

/**
 * A contextual tip shown below the info block.
 *
 * Phase 1: `text` only — stripped greeting passthrough, no source label.
 * Phase 2: `source` field added when real tip generator ships.
 * See proposal 2026-05-08 §2.2, B1 resolution.
 *
 * The `source` field is defined here so Phase 2 is a non-breaking addition.
 * Phase 1 renderers should guard: `{tip.source && <SourceLabel />}`.
 */
export interface Tip {
  text: string;
  /** Optional source label — undefined in Phase 1, set in Phase 2. */
  source?: string;
}

// ── When ─────────────────────────────────────────────────────────────────────

/**
 * Time/timezone envelope for a meeting.
 * `tz` is the viewer's primary timezone (IANA e.g. "America/New_York").
 * `otherTz` is the other party's timezone; rendered as a secondary line
 * when different from `tz`. Collapses when same-TZ per R4 spec.
 * `durationMin` in minutes.
 */
export interface MeetingWhen {
  time: Date;
  tz: string;
  /** Other party's timezone — shown only when different from `tz`. */
  otherTz?: string;
  durationMin: number;
}

// ── Series ───────────────────────────────────────────────────────────────────

/**
 * Metadata for a recurring meeting series.
 * Phase 1: types only — series rendering is stubbed (MeetingCardSeriesBlock).
 * Phase 3: series strip implementation per proposal 2026-05-08 §3.3.
 *
 * - `cadence`: human-readable repeat rule (e.g. "Weekly · Wed 4 PM")
 * - `span`: human-readable date range (e.g. "Started Mar 8 · ends Aug 15")
 * - `position`: 1-based index of the current session in the series
 * - `total`: total number of sessions in the series
 */
export interface SeriesInfo {
  cadence: string;
  /** Short cadence label for header (e.g. "Weekly piano"). */
  cadenceShort?: string;
  span: string;
  position: number;
  total: number;
  /** Date of the session AFTER this one — shown as sub-line in series row. */
  nextSessionDate?: Date;
  /** URL to the series page — e.g. /{host}/{slug}/series */
  seriesUrl?: string;
}

// ── Calendar ─────────────────────────────────────────────────────────────────

/**
 * Calendar connection state for the calendar-connect bar in MeetingCardPickerHost.
 * Discriminated union: narrow via `connected` before reading `email`.
 */
export type CalendarConnectionInfo =
  | { connected: false }
  | { connected: true; email: string };

/**
 * Google Calendar integration state, derived server-side from the booking
 * record + viewer's auth state. Drives MeetingCardCalendarRow rendering and
 * the calendar-action slot in MeetingCardActions.
 *
 * GUEST-UI ONLY in Phase 1 — never crosses the MCP wire. AP5c pre-committed
 * for any future wire exposure (see proposal § 6.1).
 */
export interface GoogleCalendarStatus {
  /** Always present after confirmation — htmlLink from GCal API. */
  eventUrl: string;

  /** Viewer's RSVP status. Null when:
   *  - viewer is anonymous (no auth), OR
   *  - viewer is registered but hasn't connected GCal, OR
   *  - viewer is the host (use otherPartyStatus instead). */
  viewerStatus: "needsAction" | "accepted" | "tentative" | "declined" | null;

  /** When viewer is the host: the GUEST's RSVP status. Undefined for guests. */
  otherPartyStatus?: "needsAction" | "accepted" | "tentative" | "declined";

  /** When otherPartyStatus is "needsAction", how long ago the invite was sent.
   *  Used to surface "Nudge {guest}" affordance when stale (>24h). */
  inviteSentAt?: Date;

  /** When viewer is registered-but-no-gcal: render Connect prompt in status row. */
  connectPromptEligible: boolean;
}

// ── EnvoyDock ────────────────────────────────────────────────────────────────

/**
 * A single chat message in the EnvoyDock thread.
 * `role` drives bubble alignment and avatar style.
 * `avatarSeed` is optional; falls back to initial letter.
 */
export interface Message {
  id: string;
  role: "guest" | "agent";
  text: string;
  timestamp: string;
  avatarSeed?: string;
  /**
   * Raw Message metadata blob for admin-only surfaces (TurnCostOverlay).
   * Populated for `role: "agent"` turns by the dock-thread mapper in
   * deal-room.tsx; omitted on guest-lane messages. Optional so non-admin
   * surfaces don't need to plumb it through.
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * Props for the EnvoyDock bottom-anchored agent surface.
 *
 * Two states:
 *  - resting: avatar + name + nudge copy + typing affordance + throb animation
 *  - thread: expanded 340px panel with message history + reply input
 *
 * State transitions are owned by the parent — callbacks signal intent.
 */
export interface EnvoyDockProps {
  /** Visual/interaction state of the dock. */
  state: "resting" | "thread";
  /** Deal-room card state — drives nudge copy selection in resting state. */
  cardState: "proposal" | "matched" | "confirming" | "confirmed" | "skipped";
  /** Host's first name — used in thread header sub-line. */
  contextHostFirstName?: string;
  /** Message history — rendered in thread state. */
  messages?: Message[];
  /** Called when user taps the resting dock to expand into thread. */
  onExpand?: () => void;
  /** Called when user taps the collapse chevron in thread header. */
  onCollapse?: () => void;
  /**
   * Called when user submits a message in thread input.
   * Non-functional in PR1 — wired in PR2. Leave the prop but don't require it.
   */
  onSendMessage?: (text: string) => void;
  /**
   * First initial of the viewer (host's first name when isHost, guest's first
   * name otherwise). Renders on the viewer-side bubble's avatar. Fixes the
   * 2026-05-12 bug where every viewer saw a hard-coded "S" regardless of role.
   */
  viewerInitial?: string;
  /**
   * Admin telemetry toggle — propagates to EnvoyDockThread, which renders
   * TurnCostOverlay + ThumbsDownFeedback under agent bubbles when true.
   * Mirrors the dashboard chat surface (feed.tsx).
   */
  isAdmin?: boolean;
  /**
   * NegotiationSession id — used by ThumbsDownFeedback under agent bubbles
   * to file feedback against the right thread.
   */
  sessionId?: string | null;
}

// ── Series Page ──────────────────────────────────────────────────────────────

/**
 * Status of an upcoming session in a recurring series.
 * Drives the badge shown on each row of the series page session list.
 */
export type UpcomingSessionStatus = "next" | "confirmed" | "skipped" | "moved";

/**
 * One row of the series page upcoming-sessions list.
 * Each row navigates to that session's event page on tap.
 */
export interface UpcomingSession {
  sessionId: string;
  position: number;      // 1-based session number in the series
  date: Date;
  tz: string;            // viewer's TZ (IANA, e.g. "America/Los_Angeles")
  durationMin: number;
  status: UpcomingSessionStatus;
  channel: ChannelInfo;  // for "Lakeside Studio" / etc. detail line
  skipReason?: string;   // when status === "skipped" — guest's note from the skip dialog
  movedFrom?: Date;      // when status === "moved"
  url: string;           // /{host}/{slug}/session-{n}
}

/**
 * Props for the SeriesPage component.
 *
 * Series page is its own dedicated route — no card chrome.
 * Header zone (title + cadence + 2 actions) + scrollable upcoming-only sessions list.
 * Past sessions are NOT shown (forward-only per Round 8 simplification).
 * No "End series" button — that lives inside the "Change series" agent flow.
 */
export interface SeriesPageProps {
  host: Participant;
  guest: Participant;
  /** "Weekly piano lesson" — the series title */
  title: string;
  /** "Wednesdays at 4:00 PM (PDT)" — full cadence sentence */
  cadence: string;
  /** Upcoming sessions (forward-only). Past sessions never rendered. */
  upcoming: UpcomingSession[];
  /** GCal series-level URL. */
  googleCalendarSeriesUrl: string;

  /** Tap "Change series" → opens agent in series-edit mode. */
  onChangeSeries?: () => void;
  /** Tap "Open in Google Calendar" → external navigation. */
  onOpenInGoogleCalendar?: () => void;
}

// ── Props ────────────────────────────────────────────────────────────────────

/**
 * Top-level props for the MeetingCard component.
 *
 * Action callbacks are optional so stub/fixture variants can omit them.
 * All callbacks receive no arguments in Phase 1 — payloads added when
 * the actions are wired to real handlers in PR2.
 */
export interface MeetingCardProps {
  /** Which side of the meeting the current viewer is on. */
  viewerRole: ViewerRole;

  /** Current phase of the scheduling negotiation. */
  state: MeetingCardState;

  /** Meeting host. */
  host: Participant;

  /** Meeting guest. */
  guest: Participant;

  /** Link/session title (e.g. "Coffee with John", "Q2 Roadmap Review"). */
  title: string;

  /**
   * Optional custom hero headline (e.g. "Moved to Thursday" for a rescheduled
   * recurring session). When omitted, hero composes a default from `state` +
   * `viewerRole` (e.g. "You're all set" for guest/confirmed, "Ready when you
   * are" for host/confirmed). See R4 mockup for state-specific defaults.
   */
  headline?: string;

  /**
   * Time, timezone, and duration.
   * In proposal/matched states, `time` is the selected or best-fit slot.
   * In confirmed state, `time` is the locked booking time.
   */
  when: MeetingWhen;

  /** How participants will connect. */
  channel: ChannelInfo;

  /**
   * Calendar connection state — drives the calendar-connect bar in MeetingCardCalendarBlock.
   * Optional: bar renders in disconnected state when absent.
   */
  calendar?: CalendarConnectionInfo;

  /**
   * Called when the guest taps "Connect →" in the calendar-connect bar.
   * Non-functional in PR1 — wired in PR2.
   */
  onConnectCalendar?: () => void;

  /**
   * Contextual tip shown below the info block.
   * Phase 1: stripped greeting passthrough, no source label.
   * Optional — card renders without a tip block when absent.
   */
  tip?: Tip;

  /**
   * Called when host taps the pencil icon next to the tip and saves a new
   * value. Wired in MeetingCardConfirmedView to PATCH Link.parameters.tip.
   * Guest never sees the pencil; this callback only fires for host viewers.
   */
  onEditTip?: (newTipText: string) => Promise<void> | void;

  /**
   * Called when a guest-picks affordance is tapped — expands the EnvoyDock
   * thread and prefills the chat input with the given text so the guest can
   * reply with their preferred venue or format.
   *
   * Optional — affordance renders even when absent (visual only, no prefill).
   * Wire up from deal-room.tsx (same pattern as onRequestEdit in ConfirmedView).
   */
  onFocusChat?: (prefill: string) => void;

  /**
   * Format deferral — the host left the meeting format up to the guest.
   *
   * When true, the host deferred format entirely (any format the guest prefers).
   * When string[], the host constrained to that subset (e.g. ["video", "phone"]).
   *
   * When set, renderer must surface an explicit affordance — NOT default to
   * "Google Meet" or any other format. `channel` on the props may carry a
   * best-effort sentinel value; the renderer should override it with the
   * deferral copy when this prop is present.
   *
   * Undefined (absent) means the format is locked and `channel` is authoritative.
   */
  formatGuestPicks?: boolean | string[];

  /**
   * Recurring series metadata.
   * Optional — present only for recurring meeting sessions.
   * Phase 1: data flows in but MeetingCardSeriesBlock renders a stub.
   */
  series?: SeriesInfo;

  /**
   * Google Calendar integration status — derived server-side from the booking
   * record + viewer's auth state. Present only for registered viewers viewing
   * confirmed meetings. Anonymous viewers → undefined (CalendarRow hidden).
   * GUEST-UI ONLY in Phase 1. AP5c pre-committed for any MCP wire exposure.
   */
  googleCalendar?: GoogleCalendarStatus;

  // ── Action callbacks ──────────────────────────────────────────────────────

  /**
   * GCal accept / confirm / re-accept — state-driven per § 3.14.
   * Label varies ("Accept in Google Calendar", "Confirm", "Re-accept") but
   * all funnel to this single callback. The MeetingCardActions label is derived
   * from googleCalendar.viewerStatus at render time.
   */
  onAcceptInGoogleCalendar?: () => void;

  /** Open the GCal event URL. Used when viewerStatus === "accepted" or for host. */
  onOpenInGoogleCalendar?: () => void;

  /** Add to calendar (anonymous / no-GCal case). */
  onAddToCalendar?: () => void;

  /** Nudge the other party (host-view, otherPartyStatus === "needsAction" + stale). */
  onNudgeOther?: () => void;

  /** Called when the guest taps "Confirm [time]". */
  onConfirm?: () => void;

  /** Called when a time slot is selected in the picker. */
  onSlotSelect?: () => void;

  /**
   * Called when the guest taps "Reschedule" (single meetings).
   * For recurring, prefer `onRescheduleSession` / `onRescheduleSeries` below.
   * If recurring callbacks are absent, recurring "Reschedule session" falls
   * back to this callback.
   */
  onReschedule?: () => void;

  /**
   * Called when guest taps "Reschedule session" on a recurring confirmed view —
   * moves just this occurrence; rest of the series stays put.
   */
  onRescheduleSession?: () => void;

  /** Alias for onRescheduleSession — preferred name per R5 spec (§ 3.7). */
  onRescheduleThis?: () => void;

  /**
   * Called when guest taps "Reschedule series" on a recurring confirmed view —
   * moves this and all future occurrences to a new anchor time.
   */
  onRescheduleSeries?: () => void;

  /**
   * Called when the guest taps "Skip session" (recurring only).
   * Cancels just this occurrence; series rhythm preserved.
   * No "Pause series" — that was deliberately replaced by Skip per
   * R4 mockup decision (proposal 2026-05-08 §Confirmed-card visual spec lock).
   */
  onSkip?: () => void;

  /** Alias for onSkip — preferred name per R5 spec (§ 3.7). */
  onSkipThis?: () => void;

  /** Called when the guest taps "Undo skip" (skipped state). */
  onUndoSkip?: () => void;

  /**
   * Called when the guest taps "Share".
   * Behavior: native share sheet on mobile (navigator.share()) /
   * copy-link-to-clipboard with toast on desktop fallback.
   * Does NOT add calendar attendees.
   * See proposal 2026-05-08 addendum A3.
   */
  onShare?: () => void;

  /**
   * More-menu actions (behind the ⋯ button).
   * Available on both single and recurring; recurring substitutes "End series"
   * for "Cancel meeting" as the destructive option.
   */

  /** "Edit meeting" — opens the agent in change-format/length/topic mode. */
  onEditMeeting?: () => void;

  /** "View on Google Calendar" — bridges to where the meeting actually lives. */
  onViewInGoogleCalendar?: () => void;

  /** "Cancel meeting" (single) — destructive; pop confirmation modal. */
  onCancel?: () => void;

  /** "End series" (recurring) — destructive; pop confirmation modal. */
  onEndSeries?: () => void;
}
