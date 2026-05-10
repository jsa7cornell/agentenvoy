import type { MeetingCardProps, ChannelInfo, ViewerRole, Tip } from "@/components/MeetingCard/types";
import { renderTip } from "@/lib/meeting-tip/render";
import { buildTipInput } from "@/lib/meeting-tip/build-input";

/**
 * Minimum fields PR2a needs from deal-room state to build MeetingCardProps.
 *
 * All fields are derived from existing useState values in deal-room.tsx —
 * no new state introduced. See proposal 2026-05-09 PR2a scope.
 */
export interface DealRoomConfirmedSnapshot {
  isHost: boolean;
  hostName: string;
  inviteeName: string;
  /** confirmData from deal-room line 264. Null when not yet confirmed. */
  confirmData: Record<string, unknown> | null;
  /** linkActivity from deal-room line 245 — for title composition. */
  linkActivity: string | null;
  /** linkLocation from deal-room line 244 — fallback for in-person channel. */
  linkLocation: string | null;
  /** sessionTimezone from deal-room line 373 — viewer-authoritative TZ. */
  sessionTimezone: string | null;
  /** slotTimezone from deal-room line 312 — fallback when sessionTimezone absent. */
  slotTimezone: string;
  /**
   * Raw link.parameters JSON — used to extract Link.parameters.tip (the
   * host-authored tip). Null when not available in current deal-room state.
   * TODO(PR2-seed): populate from link state once the store path lands.
   */
  linkParameters: Record<string, unknown> | null;
  /**
   * Host's tip from user.preferences.explicit.tip — for primary links where
   * linkParameters is absent. Populated server-side; pass null when not
   * available (renderTip falls back to DEFAULT_TIP).
   */
  userPrimaryTip?: string | null;
  /**
   * GCal event URL (htmlLink) from the confirm response. Plumbed through so
   * MeetingCardActions can show "Open in Google Calendar" immediately at
   * paint, before the async /api/negotiate/gcal-rsvp-status fetch lands.
   * The async fetch upgrades to a fuller GoogleCalendarStatus (with viewerStatus)
   * when it returns; this provides a baseline so the link is never missing.
   */
  gcalEventUrl: string | null;
  /**
   * PR2c — current session status for non-confirmed states.
   * Used to determine card state (proposal / matched / skipped / confirming).
   * "active" (default) → "proposal" card state.
   * "agreed" → handled by confirmed=true branch (caller should not pass this here).
   * "skipped" → "skipped" card state with amber treatment.
   */
  sessionStatus?: string;
  /**
   * PR2c — whether a confirming transition is in progress (1.2s state).
   * When true and !confirmData, render as confirming state.
   */
  isConfirming?: boolean;
  /**
   * PR2c — bilateral by-day availability data. When present and has "both"
   * chips, card renders in "matched" state (overlap found).
   */
  hasBilateralMatch?: boolean;
  /**
   * PR2c — link format for channel display in proposal state.
   * Derived from linkFormat in deal-room state.
   */
  linkFormat?: string;
}

// ── Proposal-state MeetingCardProps builder (PR2c) ────────────────────────────
/**
 * Builds a minimal MeetingCardProps for proposal/matched/skipped/confirming
 * states where confirmData is not yet available.
 *
 * Returns null when neither hostName nor inviteeName exists — the component
 * can't render without participant names.
 */
function buildProposalMeetingCardProps(
  snapshot: DealRoomConfirmedSnapshot,
): MeetingCardProps | null {
  // Need at least a host name to render the card safely.
  if (!snapshot.hostName && !snapshot.inviteeName) return null;

  const viewerRole: ViewerRole = snapshot.isHost ? "host" : "guest";
  const tz = snapshot.sessionTimezone || snapshot.slotTimezone;

  const splitName = (full: string | null | undefined, fallbackInitial: string) => {
    const trimmed = (full ?? "").trim();
    if (!trimmed) return { firstName: fallbackInitial, lastName: undefined };
    const parts = trimmed.split(/\s+/);
    const first = parts[0];
    return {
      firstName: first && first.length > 0 ? first : fallbackInitial,
      lastName: parts.slice(1).join(" ") || undefined,
    };
  };
  const host = splitName(snapshot.hostName, "H");
  const guest = splitName(snapshot.inviteeName, "G");

  const inviteeFirst = guest.firstName !== "G" ? guest.firstName : "";
  const title = snapshot.linkActivity
    ? `${snapshot.linkActivity}${inviteeFirst ? " with " + inviteeFirst : ""}`
    : "Meeting";

  // Determine card state
  let cardState: MeetingCardProps["state"];
  if (snapshot.isConfirming) {
    cardState = "confirming";
  } else if (snapshot.sessionStatus === "skipped") {
    cardState = "skipped";
  } else if (snapshot.hasBilateralMatch) {
    cardState = "matched";
  } else {
    cardState = "proposal";
  }

  // Channel — best-effort from link format; picker is the primary action
  const format = snapshot.linkFormat || "video";
  let channel: ChannelInfo;
  if (format === "video") {
    channel = { kind: "video", platform: "Google Meet" };
  } else if (format === "phone") {
    channel = { kind: "phone", phoneNumber: "", hostCallsGuest: true };
  } else {
    channel = { kind: "in-person", location: snapshot.linkLocation ?? "TBD" };
  }

  // Tip — same logic as confirmed path; renderTip falls back to DEFAULT_TIP
  const linkAuthoredTip =
    (snapshot.linkParameters?.tip as string | undefined) ??
    snapshot.userPrimaryTip ??
    null;
  const rendered = renderTip(
    buildTipInput({
      hostName: snapshot.hostName,
      inviteeName: snapshot.inviteeName,
      linkFormat: format,
      linkActivity: snapshot.linkActivity,
      linkLocation: snapshot.linkLocation,
      isAnonymousLink: false,
      linkAuthoredTip,
    }),
    viewerRole,
  );
  const tip: Tip | undefined = rendered
    ? { text: rendered.text, source: rendered.source }
    : undefined;

  // For proposal state, `when` is a placeholder — the Hero component in
  // proposal/matched states shows an accent stripe rather than a prominent
  // time block, so a placeholder Date is safe here.
  return {
    viewerRole,
    state: cardState,
    host,
    guest,
    title,
    when: {
      // Placeholder date — not displayed prominently in proposal/matched Hero
      time: new Date(),
      tz,
      durationMin: 30,
    },
    channel,
    tip,
  };
}

/**
 * Maps the deal-room snapshot into MeetingCardProps.
 *
 * PR2a: confirmed path only (returned null for non-confirmed states).
 * PR2c: extended to cover proposal/matched/skipped/confirming states.
 *
 * Returns null when:
 *  - confirmed: confirmData is null or dateTime is invalid
 *  - not confirmed: hostName and inviteeName are both empty
 *
 * Action callbacks are NOT passed — stubbed in the View wrappers.
 */
export function dealRoomToMeetingCardProps(
  snapshot: DealRoomConfirmedSnapshot,
): MeetingCardProps | null {
  // Not-confirmed path — PR2c
  if (!snapshot.confirmData) {
    return buildProposalMeetingCardProps(snapshot);
  }

  const cd = snapshot.confirmData;
  const dateTime =
    typeof cd.dateTime === "string" ? new Date(cd.dateTime) : null;
  if (!dateTime || isNaN(dateTime.getTime())) return null;

  const format = typeof cd.format === "string" ? cd.format : "video";
  const duration = typeof cd.duration === "number" ? cd.duration : 30;
  const location =
    typeof cd.location === "string"
      ? cd.location
      : snapshot.linkLocation ?? null;
  const meetLink =
    typeof cd.meetLink === "string" ? cd.meetLink : null;
  const tz = snapshot.sessionTimezone || snapshot.slotTimezone;

  const viewerRole: ViewerRole = snapshot.isHost ? "host" : "guest";

  // Baseline GCal status — available immediately at paint from confirmData.htmlLink.
  // The async /api/negotiate/gcal-rsvp-status fetch in MeetingCardConfirmedView
  // upgrades this to a fuller status (with viewerStatus) when it lands.
  const baselineGCal: import("@/components/MeetingCard/types").GoogleCalendarStatus | undefined =
    snapshot.gcalEventUrl
      ? {
          eventUrl: snapshot.gcalEventUrl,
          viewerStatus: null,
          connectPromptEligible: false,
        }
      : undefined;

  // Channel discrimination — Design X (role-agnostic signals, renderer composes copy)
  let channel: ChannelInfo;
  if (format === "video") {
    channel = {
      kind: "video",
      platform: meetLink?.includes("zoom.us") ? "Zoom" : "Google Meet",
      joinUrl: meetLink ?? undefined,
    };
  } else if (format === "phone") {
    // Phone: host calls guest. PR2b will add the real phoneNumber field.
    channel = { kind: "phone", phoneNumber: "(unknown)", hostCallsGuest: true };
  } else {
    // in-person (or unknown format falls back to in-person)
    channel = { kind: "in-person", location: location ?? "TBD" };
  }

  // Tip from real generator (Phase 2 — source-labeled tips)
  // linkAuthoredTip: pull from Link.parameters.tip (variance) or
  // userPrimaryTip (primary link). Falls back to DEFAULT_TIP via renderTip.
  const linkAuthoredTip =
    (snapshot.linkParameters?.tip as string | undefined) ??
    snapshot.userPrimaryTip ??
    null;
  const rendered = renderTip(
    buildTipInput({
      hostName: snapshot.hostName,
      inviteeName: snapshot.inviteeName,
      linkFormat: format,
      linkActivity: snapshot.linkActivity,
      linkLocation: snapshot.linkLocation,
      isAnonymousLink: false,
      linkAuthoredTip,
    }),
    viewerRole,
  );
  const tip: Tip | undefined = rendered
    ? { text: rendered.text, source: rendered.source }
    : undefined;

  // Title — fall back to "Meeting" if linkActivity not set
  const inviteeFirst = snapshot.inviteeName
    ? snapshot.inviteeName.split(" ")[0]
    : "";
  const title = snapshot.linkActivity
    ? `${snapshot.linkActivity}${inviteeFirst ? " with " + inviteeFirst : ""}`
    : "Meeting";

  // Participants — split name into first/last.
  // 2026-05-10 hotfix: NEVER return an empty firstName. Avatar / Hero do
  // `firstName[0].toUpperCase()` which throws TypeError on empty string.
  // When the underlying snapshot has no name (anonymous guest, host record
  // without name set, etc.) fall back to a single-letter placeholder.
  const splitName = (full: string | null | undefined, fallbackInitial: string) => {
    const trimmed = (full ?? "").trim();
    if (!trimmed) return { firstName: fallbackInitial, lastName: undefined };
    const parts = trimmed.split(/\s+/);
    const first = parts[0];
    return {
      firstName: first && first.length > 0 ? first : fallbackInitial,
      lastName: parts.slice(1).join(" ") || undefined,
    };
  };
  const host = splitName(snapshot.hostName, "H");
  const guest = splitName(snapshot.inviteeName, "G");

  return {
    viewerRole,
    state: "confirmed",
    host,
    guest,
    title,
    when: {
      time: dateTime,
      tz,
      durationMin: duration,
    },
    channel,
    tip,
    googleCalendar: baselineGCal,
  };
}
