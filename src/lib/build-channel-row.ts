/**
 * buildChannelRow — typed channel descriptor from the three-layer fallback.
 *
 * Pure function. Takes the resolved format/location/meetLink (already
 * resolved through the negotiated* > session-column > link.parameters.*
 * chain by getEffectiveMeetingState) and returns the structured ChannelInfo
 * that both deal-room and feed renderers consume.
 *
 * Previously duplicated inline in:
 *   - src/lib/series-page-props.ts buildDefaultChannel()
 *   - src/components/deal-room.tsx dealRoomToMeetingCardProps()
 *   - src/app/api/feed.tsx (inline logic)
 *
 * Unified here per the event-record-alignment proposal (2026-05-14) §2.3
 * Rule 28 discovery: "grepped for buildChannel, channelRow, formatChannel;
 * both existing sites are inlined; net-new helper is justified."
 *
 * Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md §2.3
 */

import type { ChannelInfo, TBDChannel } from "@/components/MeetingCard/types";

/**
 * Build a structured ChannelInfo from the already-resolved effective format,
 * location, and meet link.
 *
 * @param format   Resolved format string ("video" | "phone" | "in-person").
 *                 Defaults to "video" when null/undefined.
 * @param location Resolved physical location (used for in-person kind).
 * @param meetLink Google Meet / video URL (used for video kind when present).
 * @param guestPicksFormat  When true the guest has not yet picked a format;
 *                          pass through any provided values as-is.
 * @param guestPicksLocation When true the location is TBD.
 */
export function buildChannelRow(
  format: string | null | undefined,
  location: string | null | undefined,
  meetLink: string | null | undefined,
  guestPicksFormat?: boolean,
  guestPicksLocation?: boolean,
): ChannelInfo {
  // Format-deferred: guest picks — short-circuit before format branch so
  // contradictory DB state (format:"in-person" + guestPicks.format:true on
  // pre-fix links) can't win. cmp5sm07o display fix.
  if (guestPicksFormat) return { kind: "TBD" } satisfies TBDChannel;

  const resolvedFormat = format ?? "video";

  if (resolvedFormat === "in-person") {
    return {
      kind: "in-person",
      location: guestPicksLocation ? "TBD" : (location ?? "TBD"),
    };
  }

  if (resolvedFormat === "phone") {
    return {
      kind: "phone",
      phoneNumber: "",
      hostCallsGuest: true,
    };
  }

  // Default: video
  const videoChannel: ChannelInfo = {
    kind: "video",
    platform: "Google Meet",
    ...(meetLink ? { joinUrl: meetLink } : {}),
  };
  return videoChannel;
}
