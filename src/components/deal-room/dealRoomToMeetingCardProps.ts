import type { MeetingCardProps, ChannelInfo, ViewerRole, Tip } from "@/components/MeetingCard/types";
import { renderTip } from "@/lib/meeting-tip/render";
import { buildTipInput } from "@/lib/meeting-tip/build-input";
import { buildEventTitle } from "@/lib/build-event-title";

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
  /**
   * Host-named custom title from the link record (Link.customTitle, with
   * Link.topic as the migration-window fallback per PR-3 of the
   * event-data-model proposal). When set, `buildEventTitle` uses it verbatim
   * and ignores activity / format / participants. Plumbed from deal-room.tsx
   * line 1887 (the `freshTopic` state, which already does the
   * customTitle ?? topic coalesce).
   *
   * 2026-05-14 cmp4ucke5: added so the proposal-state title routes through
   * `buildEventTitle` instead of the bespoke "{activity} with {invitee}"
   * formula that drifted from the canonical "{Prefix}: {invitee} + {host}"
   * shape stored on the session.
   */
  linkCustomTitle?: string | null;
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
  /**
   * Guest-picks deferrals from link.parameters.guestPicks.
   * Only location and format are in scope for this PR; duration/window/date
   * are out of scope and should be ignored here.
   *
   * When linkGuestPicks.location === true AND the meeting is in-person, the
   * channel carries guestPicks: true and location: "" — renderer shows affordance.
   *
   * When linkGuestPicks.format is truthy (boolean or string[]), formatGuestPicks
   * is set on the returned props — renderer shows a format-pick affordance.
   *
   * Confirmed state: guestPicks signals are NOT surfaced (the picked values win).
   */
  linkGuestPicks?: {
    location?: boolean;
    format?: boolean | string[];
  } | null;
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
  // 2026-05-10 fix: when no specific guest yet (primary-link-seeded session),
  // omit the guest entirely instead of showing a "G" placeholder. The
  // who-row and avatar will detect the empty firstName and skip rendering.
  const hasGuest = !!(snapshot.inviteeName ?? "").trim();
  const guest = hasGuest
    ? splitName(snapshot.inviteeName, "G")
    : { firstName: "", lastName: undefined };

  // 2026-05-14 cmp4ucke5: route through the canonical `buildEventTitle`
  // helper so the proposal-state title matches the same `{Prefix}: {invitee}
  // + {host}` shape stored on the session (and rendered on the dashboard
  // event card). Pre-fix this used a bespoke `${linkActivity} with
  // {inviteeFirst}` formula that produced "call with Calle" while the
  // dashboard showed "Call: Calle + John" — same session, two title shapes,
  // user-visible mismatch.
  //
  // Falls back to "Meeting with {host full name}" for primary-link cases
  // (no specific invitee, no activity) — `buildEventTitle` returns "Meeting"
  // there, so we patch that one case after the call.
  const hostFullName = [host.firstName, host.lastName].filter(Boolean).join(" ");
  const inviteeFirst = hasGuest && guest.firstName !== "G" ? guest.firstName : "";
  const canonical = buildEventTitle({
    customTitle: snapshot.linkCustomTitle ?? null,
    activity: snapshot.linkActivity,
    format: snapshot.linkFormat as "in-person" | "video" | "phone" | undefined,
    isGroup: false,
    inviteeDisplay: inviteeFirst || null,
    hostFirstName: host.firstName !== "H" ? host.firstName : null,
  });
  const title =
    canonical === "Meeting" && !hasGuest && hostFullName
      ? `Meeting with ${hostFullName}`
      : canonical;

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

  // Guest-picks deferrals — only location + format are in scope here.
  const guestPicksLocation = snapshot.linkGuestPicks?.location === true;
  const guestPicksFormat = snapshot.linkGuestPicks?.format;
  const hasFormatGuestPicks = guestPicksFormat === true || Array.isArray(guestPicksFormat);

  // Channel — best-effort from link format; picker is the primary action.
  // When format is wholly deferred, default to in-person (most generic sentinel)
  // so the renderer's guestPicks affordance path handles it.
  const format = snapshot.linkFormat || (hasFormatGuestPicks ? "in-person" : "video");
  let channel: ChannelInfo;
  if (hasFormatGuestPicks) {
    // Format is deferred — use a sentinel in-person channel with empty location.
    // The renderer detects formatGuestPicks on the props and overrides this row.
    channel = { kind: "in-person", location: "" };
  } else if (format === "video") {
    channel = { kind: "video", platform: "Google Meet" };
  } else if (format === "phone") {
    channel = { kind: "phone", phoneNumber: "", hostCallsGuest: true };
  } else if (guestPicksLocation) {
    // In-person with deferred venue — empty location, guestPicks flag set.
    channel = { kind: "in-person", location: "", guestPicks: true };
  } else {
    channel = { kind: "in-person", location: snapshot.linkLocation ?? "TBD" };
  }

  // Tip — same logic as confirmed path; renderTip falls back to DEFAULT_TIP.
  // 2026-05-12 event-data-model proposal (PR-2b): linkGeneratedTip threads
  // through alongside linkAuthoredTip. Priority chain (registry.ts):
  // authored-link-tip (11, parameters.tip) > generated-tip (9, parameters
  // .generatedTip) > derived-* > generative-fallback. Both flow through here
  // so the renderer can pick the highest priority that applies.
  const linkAuthoredTip =
    (snapshot.linkParameters?.tip as string | undefined) ??
    snapshot.userPrimaryTip ??
    null;
  const linkGeneratedTip =
    (snapshot.linkParameters?.generatedTip as string | undefined) ?? null;
  const rendered = renderTip(
    buildTipInput({
      hostName: snapshot.hostName,
      inviteeName: snapshot.inviteeName,
      linkFormat: format,
      linkActivity: snapshot.linkActivity,
      linkLocation: snapshot.linkLocation,
      isAnonymousLink: false,
      linkAuthoredTip,
      linkGeneratedTip,
      guestPicksLocation,
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
    // Format deferral — only set when format is genuinely deferred (boolean or subset).
    // Absent means format is locked and channel is authoritative.
    ...(hasFormatGuestPicks
      ? { formatGuestPicks: guestPicksFormat as boolean | string[] }
      : {}),
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
    // in-person (or unknown format falls back to in-person).
    // 2026-05-11 — when there's no venue set, surface format context in the
    // fallback string rather than a bare "TBD". Two cases:
    //   - host originally deferred venue to the guest (link.parameters
    //     .guestPicks.location === true): the meeting confirmed without a
    //     pin; show "Venue TBD — guest to choose"
    //   - venue just wasn't picked: "In-person — venue TBD" so the user
    //     reads format AND status from the line, not just "TBD"
    const linkGuestPicksLocation =
      (snapshot.linkParameters?.guestPicks as { location?: boolean } | undefined)
        ?.location === true;
    const fallback = linkGuestPicksLocation
      ? "Venue TBD — guest to pick"
      : "In-person — venue TBD";
    channel = { kind: "in-person", location: location ?? fallback };
  }

  // Tip from real generator (Phase 2 — source-labeled tips)
  // linkAuthoredTip: pull from Link.parameters.tip (variance) or
  // userPrimaryTip (primary link). Falls back to DEFAULT_TIP via renderTip.
  // 2026-05-12 event-data-model proposal (PR-2b): linkGeneratedTip threads
  // through alongside linkAuthoredTip — same as the proposal-state path.
  const linkAuthoredTip =
    (snapshot.linkParameters?.tip as string | undefined) ??
    snapshot.userPrimaryTip ??
    null;
  const linkGeneratedTip =
    (snapshot.linkParameters?.generatedTip as string | undefined) ?? null;
  const rendered = renderTip(
    buildTipInput({
      hostName: snapshot.hostName,
      inviteeName: snapshot.inviteeName,
      linkFormat: format,
      linkActivity: snapshot.linkActivity,
      linkLocation: snapshot.linkLocation,
      isAnonymousLink: false,
      linkAuthoredTip,
      linkGeneratedTip,
    }),
    viewerRole,
  );
  const tip: Tip | undefined = rendered
    ? { text: rendered.text, source: rendered.source }
    : undefined;

  // Title — same canonical helper as the proposal-state path
  // (2026-05-14 cmp4ucke5). See the comment block at the proposal-state
  // builder above for the drift rationale.
  const inviteeFirst = snapshot.inviteeName
    ? snapshot.inviteeName.split(" ")[0]
    : "";
  const hostFirstNameForTitle = snapshot.hostName
    ? snapshot.hostName.split(/\s+/)[0]
    : null;
  const title = buildEventTitle({
    customTitle: snapshot.linkCustomTitle ?? null,
    activity: snapshot.linkActivity,
    format: format as "in-person" | "video" | "phone",
    isGroup: false,
    inviteeDisplay: inviteeFirst || null,
    hostFirstName: hostFirstNameForTitle,
  });

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
