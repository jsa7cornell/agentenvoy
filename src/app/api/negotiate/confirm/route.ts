import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createCalendarEvent } from "@/lib/calendar";
import { extractLearnings } from "@/agent/administrator";
import { Resend } from "resend";

// POST /api/negotiate/confirm
// Confirm an agreed-upon time — creates calendar events, sends emails
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sessionId, dateTime, duration, format, location, timezone } = body;

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

  // Resolve the host's timezone for display purposes
  const hostPrefs = session.host.preferences as Record<string, unknown> | null;
  const hostTimezone: string =
    timezone ||
    (hostPrefs?.timezone as string) ||
    ((hostPrefs?.explicit as Record<string, unknown> | undefined)?.timezone as string) ||
    "America/Los_Angeles";

  // Parse dateTime — if it includes a UTC offset (e.g., "2026-04-03T16:00:00-07:00"),
  // new Date() handles it correctly. If it's bare (legacy, no offset), interpret it
  // in the host's timezone by appending the offset.
  let dateTimeStr = dateTime as string;
  const hasOffset = /[+-]\d{2}:\d{2}$/.test(dateTimeStr) || dateTimeStr.endsWith("Z");
  if (!hasOffset) {
    // Legacy: bare ISO string without offset. Compute host's current UTC offset
    // and append it so the time is interpreted in the host's timezone, not UTC.
    const offsetStr = computeUtcOffset(hostTimezone);
    dateTimeStr = `${dateTimeStr}${offsetStr}`;
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

  const guestEmail = session.guestEmail || session.link.inviteeEmail;
  const attendeeEmails = isGroupEvent
    ? [hostEmail, ...allParticipantEmails.filter((e) => e !== hostEmail)]
    : [hostEmail, ...(guestEmail ? [guestEmail] : [])];

  // Build the deal room URL for this session
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://agentenvoy.ai";
  const dealRoomUrl = session.link.code
    ? `${baseUrl}/meet/${session.link.slug}/${session.link.code}`
    : `${baseUrl}/meet/${session.link.slug}`;

  // Create calendar event for the host
  let meetLink: string | undefined;
  let eventLink: string | undefined;

  try {
    const descriptionLines = [
      `Scheduled via AgentEnvoy`,
      `Format: ${meetingFormat}`,
      ...(location ? [`Location: ${location}`] : []),
      ...(isGroupEvent ? [`Participants: ${attendeeEmails.length}`] : []),
      "",
      `Need to change or cancel? ${dealRoomUrl}`,
    ];
    const result = await createCalendarEvent(session.hostId, {
      summary: session.link.topic
        ? `${session.link.topic} — ${session.link.inviteeName || "Meeting"}`
        : `Meeting with ${session.link.inviteeName || guestEmail || "guest"}`,
      description: descriptionLines.join("\n"),
      startTime,
      endTime,
      attendeeEmails,
      addMeetLink: meetingFormat === "video",
    });

    meetLink = result.meetLink || undefined;
    eventLink = result.htmlLink || undefined;
  } catch (e) {
    console.error("Failed to create calendar event:", e);
    // Continue anyway — calendar isn't strictly required
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

  // Update session(s) — for group events, update ALL linked sessions
  const sessionIdsToUpdate = isGroupEvent ? allParticipantSessions : [sessionId];
  const confirmSummary = `${meetingFormat} meeting on ${displayDate} at ${displayTime} ${tzAbbr}${location ? ` at ${location}` : ""}`;
  const confirmMessage = `Meeting confirmed: ${meetingFormat} on ${displayDate} at ${displayTime} ${tzAbbr}${meetLink ? `. Meet link: ${meetLink}` : ""}`;

  await prisma.negotiationSession.updateMany({
    where: { id: { in: sessionIdsToUpdate } },
    data: {
      status: "agreed",
      statusLabel: "Confirmed",
      agreedTime: startTime,
      agreedFormat: meetingFormat,
      meetLink: meetLink || null,
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

  // Save system message in ALL sessions
  await Promise.all(
    sessionIdsToUpdate.map((sid) =>
      prisma.message.create({
        data: {
          sessionId: sid,
          role: "system",
          content: confirmMessage,
        },
      })
    )
  );

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
    location,
    meetLink,
    timezone: hostTimezone,
    dealRoomUrl,
  });

  const emailRecipients = isGroupEvent
    ? attendeeEmails
    : [hostEmail, ...(guestEmail ? [guestEmail] : [])];

  let emailSent = false;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "AgentEnvoy <noreply@agentenvoy.ai>",
      to: emailRecipients,
      subject: `Meeting Confirmed${session.link.topic ? `: ${session.link.topic}` : ""}`,
      html: emailBody,
    });
    emailSent = true;
  } catch (e) {
    console.error("Failed to send confirmation email:", e);
  }

  return NextResponse.json({
    status: "confirmed",
    dateTime: startTime.toISOString(),
    duration: durationMin,
    format: meetingFormat,
    location,
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
 * Compute the UTC offset string for an IANA timezone (e.g., "-07:00" for America/Los_Angeles in PDT).
 */
function computeUtcOffset(tz: string): string {
  const now = new Date();
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
