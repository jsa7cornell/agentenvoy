import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createCalendarEvent, deleteCalendarEvent, invalidateSchedule } from "@/lib/calendar";
import { extractLearnings } from "@/agent/administrator";
import { getUserTimezone } from "@/lib/timezone";
import { sendMail } from "@/lib/mailer";

// POST /api/negotiate/confirm
// Confirm an agreed-upon time — creates calendar events, sends emails
export async function POST(req: NextRequest) {
  const body = await req.json();
  // NOTE: `timezone` from the request body is ignored. The host's timezone
  // is canonical and comes from stored preferences. LLMs must not be trusted
  // to emit IANA strings.
  const { sessionId, dateTime, duration, format, location, guestEmail: bodyGuestEmail } = body;

  if (!sessionId || !dateTime) {
    return NextResponse.json(
      { error: "Missing sessionId or dateTime" },
      { status: 400 }
    );
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      link: true,
      host: true,
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.status === "agreed") {
    return NextResponse.json(
      { error: "Session already confirmed" },
      { status: 400 }
    );
  }

  // Host's timezone is canonical — read from stored preferences, never from the body.
  const hostPrefs = session.host.preferences as Record<string, unknown> | null;
  const hostTimezone = getUserTimezone(hostPrefs);

  // Parse dateTime — if it includes a UTC offset (e.g., "2026-04-03T16:00:00-07:00"),
  // new Date() handles it correctly. If it's bare (legacy, no offset), interpret it
  // in the host's timezone by appending the offset.
  let dateTimeStr = dateTime as string;
  const hasOffset = /[+-]\d{2}:\d{2}$/.test(dateTimeStr) || dateTimeStr.endsWith("Z");
  if (!hasOffset) {
    // Legacy: bare ISO string without offset. Compute a rough date with the
    // current offset, then re-compute the offset for THAT specific date so
    // meetings scheduled across a DST boundary get the right offset.
    const roughOffset = computeUtcOffset(hostTimezone);
    const roughDate = new Date(`${dateTimeStr}${roughOffset}`);
    const dstCorrectOffset = computeUtcOffset(hostTimezone, roughDate);
    dateTimeStr = `${dateTimeStr}${dstCorrectOffset}`;
  } else {
    // Has an offset — but it may be stale if the LLM embedded "now"s offset
    // at session-creation time and the meeting crosses a DST boundary.
    // Auto-correct: parse the date as-is, compute the correct offset for that
    // date in the host timezone, and if they differ by exactly 1h re-stamp.
    const embeddedDate = new Date(dateTimeStr);
    const correctOffset = computeUtcOffset(hostTimezone, embeddedDate);
    const embeddedOffsetMatch = dateTimeStr.match(/([+-]\d{2}:\d{2})$/);
    const embeddedOffset = embeddedOffsetMatch?.[1];
    if (embeddedOffset && embeddedOffset !== correctOffset) {
      const bare = dateTimeStr.slice(0, dateTimeStr.length - embeddedOffset.length);
      dateTimeStr = `${bare}${correctOffset}`;
      console.log(
        `[confirm] DST offset corrected: ${embeddedOffset} → ${correctOffset} for "${bare}" (${hostTimezone})`
      );
    }
  }

  const startTime = new Date(dateTimeStr);
  const durationMin = duration || 30;
  const endTime = new Date(startTime.getTime() + durationMin * 60 * 1000);
  const meetingFormat = format || "video";

  const hostEmail = session.host.email;

  if (!hostEmail) {
    return NextResponse.json(
      { error: "Host email not found" },
      { status: 400 }
    );
  }

  // Determine if this is a group event
  const isGroupEvent = session.link.mode === "group";
  let allParticipantEmails: string[] = [];
  let allParticipantSessions: string[] = [];

  if (isGroupEvent) {
    const participants = await prisma.sessionParticipant.findMany({
      where: { linkId: session.linkId },
    });
    allParticipantEmails = participants
      .map((p) => p.email)
      .filter((e): e is string => !!e);
    allParticipantSessions = participants.map((p) => p.sessionId);
  }

  // Prefer DB-persisted email (written by save_guest_info action), fall back
  // to the client-supplied value from deal-room.tsx state (populated after
  // save_guest_info re-fetch). This ensures the Google Calendar invite always
  // includes the guest even when the LLM forgot to call save_guest_info first.
  const guestEmail = session.guestEmail || session.link.inviteeEmail || (bodyGuestEmail as string | undefined) || null;
  if (!guestEmail) {
    console.warn(`[confirm] sessionId=${sessionId} — no guest email found; calendar invite will only have host.`);
  }
  const attendeeEmails = isGroupEvent
    ? [hostEmail, ...allParticipantEmails.filter((e) => e !== hostEmail)]
    : [hostEmail, ...(guestEmail ? [guestEmail] : [])];

  // Build the deal room URL for this session
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://agentenvoy.ai";
  const dealRoomUrl = session.link.code
    ? `${baseUrl}/meet/${session.link.slug}/${session.link.code}`
    : `${baseUrl}/meet/${session.link.slug}`;

  // Resolve meeting settings from preferences
  const hostPhone = (hostPrefs?.phone as string) || null;
  const videoProvider = (hostPrefs?.videoProvider as string) || "google-meet";
  const zoomLink = (hostPrefs?.zoomLink as string) || null;

  // Build event summary — format-aware
  const guestLabel = session.link.inviteeName || guestEmail || "guest";
  const hostLabel = session.host.name || "Host";
  const eventSummary = (() => {
    if (session.link.topic) {
      return `${session.link.topic} — ${guestLabel}`;
    }
    if (meetingFormat === "phone") {
      return `Phone call: ${guestLabel} & ${hostLabel}`;
    }
    return `Meeting with ${guestLabel}`;
  })();

  // Default location — phone calls get host's number, Zoom gets the link
  const effectiveLocation = location
    || (meetingFormat === "phone" && hostPhone
      ? `${guestLabel} calls ${session.host.name || "host"} @ ${hostPhone}`
      : null)
    || (meetingFormat === "video" && videoProvider === "zoom" && zoomLink
      ? zoomLink
      : null);

  // Create calendar event for the host
  let meetLink: string | undefined;
  let eventLink: string | undefined;
  let confirmedCalendarEventId: string | undefined;

  try {
    const descriptionLines = [
      `Scheduled via AgentEnvoy`,
      `Format: ${meetingFormat}`,
      ...(effectiveLocation ? [`Location: ${effectiveLocation}`] : []),
      ...(isGroupEvent ? [`Participants: ${attendeeEmails.length}`] : []),
      "",
      `Need to change or cancel? ${dealRoomUrl}`,
    ];
    // For Zoom: skip Google Meet auto-creation, use the host's Zoom link
    const useGoogleMeet = meetingFormat === "video" && videoProvider !== "zoom";
    const useZoom = meetingFormat === "video" && videoProvider === "zoom" && !!zoomLink;

    const result = await createCalendarEvent(session.hostId, {
      summary: eventSummary,
      description: descriptionLines.join("\n"),
      startTime,
      endTime,
      attendeeEmails,
      addMeetLink: useGoogleMeet,
      sessionId: session.id,
    });

    if (useZoom) {
      meetLink = zoomLink!;
    } else {
      meetLink = result.meetLink || undefined;
    }
    eventLink = result.htmlLink || undefined;
    confirmedCalendarEventId = result.eventId || undefined;
  } catch (e) {
    console.error("Failed to create calendar event:", e);
    // Continue anyway — calendar isn't strictly required
  }

  // Invalidate the schedule cache so the availability widget immediately
  // reflects the new booking instead of showing the slot for up to 5 minutes.
  try {
    await invalidateSchedule(session.hostId);
  } catch (e) {
    console.warn("[confirm] schedule cache invalidation failed (non-blocking):", e);
  }

  // Format times in the host's timezone for display
  const displayDate = startTime.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: hostTimezone,
  });
  const displayTime = startTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: hostTimezone,
  });
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
    timeZone: hostTimezone,
  })
    .formatToParts(startTime)
    .find((p) => p.type === "timeZoneName")?.value ?? hostTimezone;

  // Clear any active holds on this session — the meeting is now confirmed,
  // so the tentative protection is no longer needed. We flip hold.status to
  // "satisfied" and delete the backing tentative calendar event so the
  // real confirmed event (created above) is the only thing on the host's
  // calendar for this time. Non-blocking on gcal failures.
  //
  // If any holds were satisfied, this was a "stretch booking" — Envoy
  // reached into the host's protected time on a VIP link and the guest
  // confirmed. Post a system message into the host's dashboard channel
  // so the host is explicitly aware ("that stretch slot just landed").
  let hadStretchHold = false;
  try {
    const activeHolds = await prisma.hold.findMany({
      where: { sessionId, status: "active" },
      select: { id: true, calendarEventId: true },
    });
    if (activeHolds.length > 0) {
      hadStretchHold = true;
      await Promise.all(
        activeHolds.map(async (h) => {
          if (!h.calendarEventId) return;
          try {
            await deleteCalendarEvent(session.hostId, h.calendarEventId);
          } catch (e) {
            console.warn(
              `[confirm] could not delete tentative hold event ${h.calendarEventId}:`,
              e
            );
          }
        })
      );
      await prisma.hold.updateMany({
        where: { sessionId, status: "active" },
        data: { status: "satisfied" },
      });
    }
  } catch (e) {
    // Non-blocking — confirmation itself still succeeds even if hold
    // cleanup fails. The cron sweeper will pick up any orphaned holds.
    console.error("[confirm] hold satisfaction cleanup failed:", e);
  }

  // Update session(s) — for group events, update ALL linked sessions
  const sessionIdsToUpdate = isGroupEvent ? allParticipantSessions : [sessionId];
  const confirmSummary = `${meetingFormat} meeting on ${displayDate} at ${displayTime} ${tzAbbr}${effectiveLocation ? ` — ${effectiveLocation}` : ""}`;

  await prisma.negotiationSession.updateMany({
    where: { id: { in: sessionIdsToUpdate } },
    data: {
      status: "agreed",
      // statusLabel stays null on confirmation — the status pill in the
      // header already renders "Confirmed" from statusConfig, and setting
      // it here used to produce a duplicate label next to the pill.
      statusLabel: null,
      agreedTime: startTime,
      agreedFormat: meetingFormat,
      meetLink: meetLink || null,
      calendarEventId: confirmedCalendarEventId || null,
      summary: confirmSummary,
    },
  });

  // Update all participant statuses to "agreed"
  if (isGroupEvent) {
    await prisma.sessionParticipant.updateMany({
      where: { linkId: session.linkId },
      data: { status: "agreed" },
    });
  }

  // (No system "Meeting confirmed" message — the inline green card below
  // the administrator's proposal, plus the header status pill, already
  // communicate the confirmation. The duplicate system notice under the
  // last message was visual noise.)

  // Stretch booking notification — when a confirmed meeting had an active
  // hold on it, that means Envoy reached into the host's protected time on
  // a VIP link and this was the payoff. Post a system message into the
  // host's dashboard channel so the host is explicitly notified ("that
  // stretch slot you approved just landed"). Linked to the thread so it
  // renders as a thread-card update in the dashboard feed.
  if (hadStretchHold) {
    try {
      let channel = await prisma.channel.findUnique({
        where: { userId: session.hostId },
      });
      if (!channel) {
        channel = await prisma.channel.create({ data: { userId: session.hostId } });
      }
      const guestLabel = session.link.inviteeName || guestEmail || "the guest";
      const stretchNote =
        `Stretch slot confirmed for ${guestLabel}: ${displayDate} at ${displayTime} ${tzAbbr}. ` +
        `This was a VIP hold you approved earlier — the guest accepted and it's now on your calendar.`;
      await prisma.channelMessage.create({
        data: {
          channelId: channel.id,
          role: "envoy",
          content: stretchNote,
          threadId: sessionId,
        },
      });
    } catch (e) {
      // Non-blocking — the confirmation succeeded, this is just the
      // courtesy heads-up in the dashboard feed.
      console.error("[confirm] stretch booking channel notification failed:", e);
    }
  }

  // Create NegotiationOutcome for tracking
  try {
    const messages = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });
    const guestMessages = messages.filter((m) => m.role === "guest");
    const hasCounterProposal = guestMessages.some((m) =>
      /none of|don't work|doesn't work|how about|instead|different/i.test(m.content)
    );
    const timeToConfirmationSec = Math.round(
      (Date.now() - session.createdAt.getTime()) / 1000
    );

    await prisma.negotiationOutcome.create({
      data: {
        sessionId,
        exchangeCount: guestMessages.length,
        tierReached: 1, // TODO: track tier progression
        guestCounterProposed: hasCounterProposal,
        timeToConfirmationSec,
        proposedFormat: session.format || null,
        agreedFormat: meetingFormat,
        participantCount: isGroupEvent ? attendeeEmails.length : 2,
      },
    });
  } catch (e) {
    console.error("Failed to create NegotiationOutcome:", e);
  }

  // Extract learnings and update host knowledge base
  try {
    const allMessages = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });
    const transcript = allMessages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");
    const updates = await extractLearnings(
      transcript,
      session.host.persistentKnowledge,
      session.host.upcomingSchedulePreferences,
      session.host.name || "host"
    );
    await prisma.user.update({
      where: { id: session.hostId },
      data: {
        persistentKnowledge: updates.persistent,
        upcomingSchedulePreferences: updates.situational,
      },
    });
  } catch (e) {
    console.error("Failed to extract learnings:", e);
    // Non-blocking — confirmation already succeeded
  }

  // Send confirmation emails
  const emailBody = buildConfirmationEmail({
    hostName: session.host.name || "The organizer",
    guestName: session.link.inviteeName || undefined,
    topic: session.link.topic || undefined,
    dateTime: startTime,
    duration: durationMin,
    format: meetingFormat,
    location: effectiveLocation || undefined,
    meetLink,
    timezone: hostTimezone,
    dealRoomUrl,
  });

  const emailRecipients = isGroupEvent
    ? attendeeEmails
    : [hostEmail, ...(guestEmail ? [guestEmail] : [])];

  const mailResult = await sendMail({
    to: emailRecipients,
    subject: `Meeting Confirmed${session.link.topic ? `: ${session.link.topic}` : ""}`,
    html: emailBody,
  });
  const emailSent = mailResult.sent;

  return NextResponse.json({
    status: "confirmed",
    dateTime: startTime.toISOString(),
    duration: durationMin,
    format: meetingFormat,
    location: effectiveLocation || location || null,
    meetLink,
    eventLink,
    emailSent,
  });
}

// PATCH /api/negotiate/confirm
// Update feedback on a NegotiationOutcome
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { sessionId, feedback } = body;

  if (!sessionId || !feedback) {
    return NextResponse.json(
      { error: "Missing sessionId or feedback" },
      { status: 400 }
    );
  }

  try {
    await prisma.negotiationOutcome.update({
      where: { sessionId },
      data: { feedback },
    });
    return NextResponse.json({ status: "updated" });
  } catch {
    return NextResponse.json(
      { error: "Outcome not found" },
      { status: 404 }
    );
  }
}

/**
 * Compute the UTC offset string for an IANA timezone at a specific date
 * (e.g., "-07:00" for America/Los_Angeles in PDT, "-08:00" in PST).
 * Pass `date` to get the DST-correct offset for a future meeting time — if
 * omitted, defaults to now (stale for meetings that cross a DST boundary).
 */
function computeUtcOffset(tz: string, date: Date = new Date()): string {
  const now = date;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = offsetPart.match(/GMT([+-]\d{2}:\d{2})/);
  if (match) return match[1];
  if (offsetPart === "GMT") return "+00:00";
  // Fallback
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = now.toLocaleString("en-US", { timeZone: tz });
  const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const diffMin = Math.round(diffMs / 60000);
  const sign = diffMin >= 0 ? "+" : "-";
  const absMin = Math.abs(diffMin);
  const h = String(Math.floor(absMin / 60)).padStart(2, "0");
  const m = String(absMin % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

function buildConfirmationEmail(params: {
  hostName: string;
  guestName?: string;
  topic?: string;
  dateTime: Date;
  duration: number;
  format: string;
  location?: string;
  meetLink?: string;
  timezone?: string;
  dealRoomUrl?: string;
}) {
  const tz = params.timezone || "America/Los_Angeles";
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
    timeZone: tz,
  })
    .formatToParts(params.dateTime)
    .find((p) => p.type === "timeZoneName")?.value ?? tz;

  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 48px; margin-bottom: 8px;">✅</div>
        <h1 style="font-size: 24px; font-weight: 700; color: #1a1a2e; margin: 0;">Meeting Confirmed</h1>
      </div>
      <div style="background: #f8f8fc; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        ${params.topic ? `<p style="margin: 0 0 12px 0; font-size: 16px; font-weight: 600;">${params.topic}</p>` : ""}
        <p style="margin: 0 0 8px 0; color: #666;">📅 ${params.dateTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: tz })}</p>
        <p style="margin: 0 0 8px 0; color: #666;">🕐 ${params.dateTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })} ${tzAbbr} (${params.duration} min)</p>
        <p style="margin: 0 0 8px 0; color: #666;">📱 ${params.format.charAt(0).toUpperCase() + params.format.slice(1)}</p>
        ${params.location ? `<p style="margin: 0 0 8px 0; color: #666;">📍 ${params.location}</p>` : ""}
        ${params.meetLink ? `<p style="margin: 0;"><a href="${params.meetLink}" style="color: #6c5ce7; font-weight: 600;">Join Google Meet</a></p>` : ""}
      </div>
      ${params.dealRoomUrl ? `
      <div style="text-align: center; margin-bottom: 20px;">
        <a href="${params.dealRoomUrl}" style="display: inline-block; padding: 10px 24px; background: #f8f8fc; border: 1px solid #e0e0e8; border-radius: 8px; color: #6c5ce7; font-size: 13px; font-weight: 600; text-decoration: none;">Need to change or cancel?</a>
      </div>
      ` : ""}
      <p style="text-align: center; font-size: 13px; color: #999;">
        Scheduled by <a href="https://agentenvoy.ai" style="color: #6c5ce7;">AgentEnvoy</a> — your AI negotiates so you don't have to.
      </p>
    </div>
  `;
}
