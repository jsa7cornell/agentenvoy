/**
 * fetchSeriesPageProps — data loader for the /[host]/[slug]/series route (PR3).
 *
 * Returns SeriesPageProps built from:
 *   - The NegotiationLink's recurrence config (expanded to upcoming occurrences)
 *   - Any LinkOccurrence divergences (cancelled / rescheduled / moved)
 *   - The confirmed NegotiationSession for guest identity + channel info
 *
 * URL convention (route [host]/[slug]/series):
 *   - host = user.meetSlug
 *   - slug = link.code (personalized/contextual links), OR user.meetSlug again
 *     (primary links, which have code = null and slug = meetSlug)
 *
 * Returns null when:
 *   - Host user not found
 *   - Link not found or not owned by this host
 *   - Link has no recurrence (non-series link)
 *   - Anchor not yet committed (pre-pick state — no times to show)
 *
 * Proposal: proposals/2026-05-14_recurring-event-page-render-and-confirm_
 *   reviewed-2026-05-14_decided-2026-05-14.md §3.5.2 (PR3)
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  readRecurrence,
  isAnchorCommitted,
  expandRecurrence,
  localWallToUTC,
  type CommittedLinkRecurrence,
} from "@/lib/recurrence";
import { parseLinkParameters } from "@/lib/link-parameters";
import type {
  SeriesPageProps,
  UpcomingSession,
  UpcomingSessionStatus,
  ChannelInfo,
  Participant,
} from "@/components/MeetingCard/types";

// ── Cadence sentence ──────────────────────────────────────────────────────────

/**
 * Full cadence sentence for the series page header.
 * Example: "Thursdays at 10:00 AM (PDT) · with Maya"
 *
 * Exported for unit testing only — consume via fetchSeriesPageProps in production.
 */
export function formatCadenceSentence(
  rec: CommittedLinkRecurrence,
  hostFirstName: string,
): string {
  const { firstDateLocal, timeLocal } = rec.anchor;

  // Day name — derive from firstDateLocal interpreted at noon in the timezone
  // (noon avoids DST-edge issues).
  const [y, mo, d] = firstDateLocal.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const localParts = new Intl.DateTimeFormat("en-US", {
    timeZone: rec.timezone,
    weekday: "long",
  }).formatToParts(noonUtc);
  const weekdayLong = localParts.find((p) => p.type === "weekday")?.value ?? "day";

  // Make plural: e.g. "Thursday" → "Thursdays"
  const dayPlural = weekdayLong.endsWith("s") ? weekdayLong : `${weekdayLong}s`;

  // Pattern prefix for non-weekly cadences
  let prefix = "";
  if (rec.pattern === "biweekly") prefix = "Every other ";
  else if (rec.pattern === "monthly_nth_weekday") prefix = "Monthly on ";
  else if (rec.pattern === "daily") return `Daily at ${formatTime12h(timeLocal)} · with ${hostFirstName}`;

  // Time in 12h format and timezone abbreviation
  const anchorUtc = localWallToUTC(firstDateLocal, timeLocal, rec.timezone);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: rec.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(anchorUtc);
  // "10:00 AM PDT" → split into time part and tz abbreviation
  const tzMatch = formatted.match(/([A-Z]{2,5})$/);
  const tzAbbr = tzMatch ? tzMatch[1] : rec.timezone;
  // Strip the tz part from the formatted string to get just the time
  const timePart = formatted.replace(/\s*[A-Z]{2,5}$/, "").trim();

  return `${prefix}${dayPlural} at ${timePart} (${tzAbbr}) · with ${hostFirstName}`;
}

/** Convert "HH:mm" 24h to "H:MM AM/PM" 12h format. */
function formatTime12h(timeLocal: string): string {
  const [h, m] = timeLocal.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minutes = String(m).padStart(2, "0");
  return minutes === "00" ? `${hour12} ${ampm}` : `${hour12}:${minutes} ${ampm}`;
}

// ── Name helpers ──────────────────────────────────────────────────────────────

function splitName(fullName: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (fullName ?? "").trim().split(/\s+/);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

// ── Channel builder ───────────────────────────────────────────────────────────

function buildDefaultChannel(
  linkParams: ReturnType<typeof parseLinkParameters>,
  sessionFormat: string | null | undefined,
  sessionMeetLink: string | null | undefined,
): ChannelInfo {
  const format = sessionFormat ?? linkParams.format ?? "video";
  if (format === "in-person") {
    return { kind: "in-person", location: linkParams.location ?? "TBD" };
  }
  if (format === "phone") {
    return { kind: "phone", phoneNumber: "", hostCallsGuest: true };
  }
  // Default: video
  return {
    kind: "video",
    platform: "Google Meet",
    ...(sessionMeetLink ? { meetingUrl: sessionMeetLink } : {}),
  };
}

// ── Deal-room URL ─────────────────────────────────────────────────────────────

function linkUrl(meetSlug: string, code: string | null | undefined): string {
  return code ? `/meet/${meetSlug}/${code}` : `/meet/${meetSlug}`;
}

// ── Core fetcher ──────────────────────────────────────────────────────────────

export async function fetchSeriesPageProps(
  host: string,
  slug: string,
): Promise<SeriesPageProps | null> {
  // 1. Find user by meetSlug.
  const user = await prisma.user.findUnique({
    where: { meetSlug: host },
    select: { id: true, name: true, meetSlug: true },
  });
  if (!user) return null;

  // 2. Look up the NegotiationLink.
  //    Primary link: code is null and slug = meetSlug (so host === slug in the URL).
  //    Personalized link: code = slug param in the URL.
  const isPrimaryLink = slug === host;
  const link = await prisma.negotiationLink.findFirst({
    where: isPrimaryLink
      ? { userId: user.id, type: "primary" }
      : { userId: user.id, code: slug },
    select: {
      id: true,
      slug: true,
      code: true,
      customTitle: true,
      topic: true,
      recurrence: true,
      seriesGcalEventId: true,
      parameters: true,
      sessions: {
        where: { status: "agreed" },
        orderBy: { agreedTime: "asc" },
        take: 1,
        select: {
          id: true,
          guestName: true,
          agreedFormat: true,
          meetLink: true,
        },
      },
      occurrences: {
        select: {
          originalStartAt: true,
          status: true,
          actualStartAt: true,
          actualEndAt: true,
          actualFormat: true,
          actualLocation: true,
        },
      },
    },
  });

  if (!link) return null;

  // 3. Parse and validate recurrence.
  const rec = readRecurrence(link.recurrence as Prisma.JsonValue);
  if (!rec || !isAnchorCommitted(rec)) return null;

  // 4. Count past occurrences to compute 1-based positions.
  //    Expand from series-start (effectively 0) to now — pure CPU, no I/O.
  const now = new Date();
  const seriesStart = localWallToUTC(
    rec.anchor.firstDateLocal,
    rec.anchor.timeLocal,
    rec.timezone,
  );
  // Include ALL occurrences from the start so positions are absolute in the series.
  const pastOccurrences =
    now > seriesStart
      ? expandRecurrence(rec, seriesStart, new Date(now.getTime() - 1))
      : [];
  const pastCount = pastOccurrences.length;

  // 5. Expand upcoming occurrences (2-year horizon).
  const horizon = new Date(now.getTime() + 365 * 2 * 24 * 60 * 60 * 1000);
  const expanded = expandRecurrence(rec, now, horizon);

  if (expanded.length === 0 && pastCount === 0) return null;

  // 6. Build divergence index: originalStartAt (ms) → LinkOccurrence row.
  const divergenceMap = new Map(
    link.occurrences.map((o) => [o.originalStartAt.getTime(), o]),
  );

  // 7. Parse link parameters for channel/format defaults.
  const params = parseLinkParameters(link.parameters);
  const confirmedSession = link.sessions[0] ?? null;
  const defaultChannel = buildDefaultChannel(
    params,
    confirmedSession?.agreedFormat,
    confirmedSession?.meetLink,
  );

  // 8. Build UpcomingSession[] from expanded occurrences.
  const sessionUrl = linkUrl(user.meetSlug!, link.code);
  const upcoming: UpcomingSession[] = expanded.map((occ, i) => {
    const position = pastCount + i + 1;
    const divergence = divergenceMap.get(occ.startAt.getTime());

    let status: UpcomingSessionStatus;
    if (divergence?.status === "cancelled") status = "skipped";
    else if (divergence?.status === "rescheduled") status = "moved";
    else if (i === 0) status = "next";
    else status = "confirmed";

    const effectiveStart = divergence?.actualStartAt ?? occ.startAt;
    const effectiveChannel: ChannelInfo =
      divergence?.actualFormat === "in-person" && divergence.actualLocation
        ? { kind: "in-person", location: divergence.actualLocation }
        : defaultChannel;

    return {
      sessionId: confirmedSession && i === 0 ? confirmedSession.id : `${link.id}#${occ.startAt.getTime()}`,
      position,
      date: effectiveStart,
      tz: rec.timezone,
      durationMin: rec.anchor.durationMin,
      status,
      channel: effectiveChannel,
      ...(status === "moved" ? { movedFrom: occ.startAt } : {}),
      url: sessionUrl,
    };
  });

  // 9. Participants.
  const { firstName: hostFirst, lastName: hostLast } = splitName(user.name);
  const hostParticipant: Participant = { firstName: hostFirst, lastName: hostLast };

  const guestParticipant: Participant = splitName(confirmedSession?.guestName ?? null);

  // 10. Title.
  const title =
    link.customTitle ??
    link.topic ??
    `Recurring meeting with ${hostFirst}`;

  // 11. Cadence sentence.
  const cadence = formatCadenceSentence(rec, hostFirst);

  // 12. GCal series URL.
  const googleCalendarSeriesUrl = link.seriesGcalEventId
    ? `https://calendar.google.com/calendar/r/eventedit?eid=${link.seriesGcalEventId}`
    : "https://calendar.google.com/calendar/r";

  return {
    host: hostParticipant,
    guest: guestParticipant,
    title,
    cadence,
    upcoming,
    googleCalendarSeriesUrl,
  };
}
