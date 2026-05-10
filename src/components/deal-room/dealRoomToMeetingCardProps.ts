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
}

/**
 * Maps the deal-room confirmed snapshot into MeetingCardProps for PR2a.
 *
 * Returns null when:
 *  - confirmData is null (not yet confirmed)
 *  - confirmData.dateTime is missing or not a valid date string
 *
 * Action callbacks are NOT passed — they are stubbed in MeetingCardConfirmedView
 * for PR2a. Real handlers wired in PR2c.
 */
export function dealRoomToMeetingCardProps(
  snapshot: DealRoomConfirmedSnapshot,
): MeetingCardProps | null {
  if (!snapshot.confirmData) return null;

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
  const rendered = renderTip(
    buildTipInput({
      hostName: snapshot.hostName,
      inviteeName: snapshot.inviteeName,
      linkFormat: format,
      linkActivity: snapshot.linkActivity,
      linkLocation: snapshot.linkLocation,
      isAnonymousLink: false,
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

  // Participants — split name into first/last
  const splitName = (full: string) => {
    const parts = full.trim().split(/\s+/);
    return {
      firstName: parts[0] ?? "",
      lastName: parts.slice(1).join(" ") || undefined,
    };
  };
  const host = splitName(snapshot.hostName);
  const guest = splitName(snapshot.inviteeName);

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
    // googleCalendar: undefined — PR2b adds the real server-side fetch
  };
}
