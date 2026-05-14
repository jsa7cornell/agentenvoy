/**
 * getEffectiveMeetingState — single-source-of-truth renderer for confirmed
 * and in-negotiation meetings.
 *
 * Implements the three-layer fallback chain:
 *   negotiated* > session-column > link.parameters.*
 *
 * Both deal-room and feed renderers call this function. Same input → same
 * output — the two surfaces cannot disagree.
 *
 * ### Fallback chain
 * | Field    | Layer 1 (guest override)       | Layer 2 (session col) | Layer 3 (link params) | Default |
 * |----------|---------------------------------|-----------------------|------------------------|---------|
 * | activity | session.negotiatedActivity     | —                     | link.parameters.activity | null  |
 * | format   | session.negotiatedFormat       | session.format        | link.parameters.format | "video" |
 * | duration | session.negotiatedDuration     | session.duration      | link.parameters.duration | 30   |
 * | location | session.negotiatedLocation     | session.location      | link.parameters.location | null |
 *
 * ### Host-edit invariant (2026-04-22 R2/option-a — not changed by this proposal)
 * When the host edits the underlying link, handleUpdateLink clears the
 * session's negotiated* columns for all active sessions. After the clear,
 * the fallback automatically lands on the new link value. This helper does
 * NOT implement that invariant — it just reads what's in the DB.
 *
 * Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md §2.3
 */

import { buildEventTitle } from "./build-event-title";
import { buildChannelRow } from "./build-channel-row";
import { emojiForActivity } from "./activity-vocab";
import { parseLinkParameters } from "./link-parameters";
import { getInviteeDisplay, getInviteeFirstNamesDisplay, getInviteeNames } from "./invitee-display";
import type { ChannelInfo } from "@/components/MeetingCard/types";

// ── SessionWithLink type ───────────────────────────────────────────────────

/**
 * Minimal session shape required by getEffectiveMeetingState.
 *
 * All fields are optional/nullable so callers can pass any Prisma-select
 * result without having to pre-include every column — the helper falls
 * back gracefully when a field is absent.
 */
export interface SessionWithLink {
  /** Session-level negotiated overrides (guest's locked values). */
  negotiatedActivity?: string | null;
  negotiatedFormat?: string | null;
  negotiatedDuration?: number | null;
  negotiatedLocation?: string | null;
  /** Session-level columns (set at confirm time). */
  format?: string | null;
  duration?: number | null;
  location?: string | null;
  meetLink?: string | null;
  /** Status string ("active" | "agreed" | etc.). */
  status?: string | null;
  /** When the session was confirmed. */
  agreedTime?: Date | null;
  /** The join-fetched link. Required. */
  link: {
    customTitle?: string | null;
    inviteeName?: string | null;
    inviteeNames?: string[];
    parameters?: unknown;
    user?: { name?: string | null } | null;
  };
}

// ── EffectiveMeetingState type ─────────────────────────────────────────────

/** Fully resolved display state for one meeting. */
export interface EffectiveMeetingState {
  /** Resolved activity string (e.g. "coffee", "bike-ride"). */
  activity: string | null;
  /** Resolved format ("video" | "phone" | "in-person"). Default "video". */
  format: string;
  /** Resolved duration in minutes. Default 30. */
  duration: number;
  /** Resolved physical location. Null when not applicable. */
  location: string | null;
  /** Host-authored title override from Link.customTitle. */
  customTitle: string | null;
  /** Invitee's name (single-guest short form). */
  invitee: string | null;
  /** Session status. */
  status: string | null;
  /** Confirmed time (null until agreed). */
  agreedTime: Date | null;
  /**
   * Canonical event title.
   *
   * Derived: customTitle wins verbatim; otherwise buildEventTitle
   * from activity + format + invitee display + host name.
   */
  title: string;
  /** Activity emoji (null when activity is unknown). */
  emoji: string | null;
  /** Structured channel descriptor for the meeting-card channel row. */
  channelRow: ChannelInfo;
}

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Derive the fully-resolved display state for a session.
 *
 * @param session   A session object with a joined `link`. Select whichever
 *                  columns you need; unselected fields fall back gracefully.
 *
 * @returns EffectiveMeetingState — pure, no I/O.
 */
export function getEffectiveMeetingState(session: SessionWithLink): EffectiveMeetingState {
  const link = session.link;
  const params = parseLinkParameters(link.parameters ?? null);

  // ── Three-layer fallback chain ───────────────────────────────────────────
  const activity = session.negotiatedActivity ?? params.activity ?? null;
  // Track explicit vs. default separately: buildEventTitle should not derive
  // "VC"/"Call" prefixes from the "video" default — only from an explicit source.
  const explicitFormat =
    session.negotiatedFormat ?? session.format ?? params.format ?? null;
  const format = explicitFormat ?? "video";
  const duration =
    session.negotiatedDuration ?? session.duration ?? params.duration ?? 30;
  const location =
    session.negotiatedLocation ?? session.location ?? params.location ?? null;

  // ── Derived display fields ───────────────────────────────────────────────
  const hostFirstName = splitFirstName(link.user?.name ?? null);
  const inviteeDisplay = getInviteeDisplay({
    inviteeNames: link.inviteeNames,
    inviteeName: link.inviteeName,
  });
  const firstNamesDisplay = getInviteeFirstNamesDisplay({
    inviteeNames: link.inviteeNames,
    inviteeName: link.inviteeName,
  });
  const isGroup = getInviteeNames({
    inviteeNames: link.inviteeNames,
    inviteeName: link.inviteeName,
  }).length > 1;

  const title = buildEventTitle({
    customTitle: link.customTitle,
    activity,
    format: explicitFormat as "video" | "phone" | "in-person" | null,
    isGroup,
    inviteeDisplay: inviteeDisplay || null,
    firstNamesDisplay: firstNamesDisplay || null,
    hostFirstName,
  });

  const emoji = params.activityIcon ?? emojiForActivity(
    activity,
    format as "video" | "phone" | "in-person" | null,
  );

  const channelRow = buildChannelRow(format, location, session.meetLink ?? null);

  return {
    activity,
    format,
    duration,
    location,
    customTitle: link.customTitle ?? null,
    invitee: link.inviteeName ?? null,
    status: session.status ?? null,
    agreedTime: session.agreedTime ?? null,
    title,
    emoji: emoji ?? null,
    channelRow,
  };
}

// ── Utility ────────────────────────────────────────────────────────────────

function splitFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  return fullName.trim().split(/\s+/)[0] ?? null;
}
