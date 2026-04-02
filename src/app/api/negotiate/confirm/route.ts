import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createCalendarEvent } from "@/lib/calendar";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// POST /api/negotiate/confirm
// Confirm an agreed-upon time — creates calendar events, sends emails
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sessionId, dateTime, duration, format, location } = body;

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
      initiator: true,
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

  const startTime = new Date(dateTime);
  const durationMin = duration || 30;
  const endTime = new Date(startTime.getTime() + durationMin * 60 * 1000);
  const meetingFormat = format || "video";

  const responderEmail = session.responderEmail || session.link.inviteeEmail;
  const initiatorEmail = session.initiator.email;

  if (!initiatorEmail) {
    return NextResponse.json(
      { error: "Initiator email not found" },
      { status: 400 }
    );
  }

  // Create calendar event for the initiator
  let meetLink: string | undefined;
  let eventLink: string | undefined;

  try {
    const result = await createCalendarEvent(session.initiatorId, {
      summary: session.link.topic
        ? `${session.link.topic} — ${session.link.inviteeName || "Meeting"}`
        : `Meeting with ${session.link.inviteeName || responderEmail || "guest"}`,
      description: `Scheduled via Envoy\nFormat: ${meetingFormat}${location ? `\nLocation: ${location}` : ""}`,
      startTime,
      endTime,
      attendeeEmails: [
        initiatorEmail,
        ...(responderEmail ? [responderEmail] : []),
      ],
      addMeetLink: meetingFormat === "video",
    });

    meetLink = result.meetLink || undefined;
    eventLink = result.htmlLink || undefined;
  } catch (e) {
    console.error("Failed to create calendar event:", e);
    // Continue anyway — calendar isn't strictly required
  }

  // Update session
  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: {
      status: "agreed",
      statusLabel: "Confirmed",
      agreedTime: startTime,
      agreedFormat: meetingFormat,
      meetLink: meetLink || null,
      summary: `${meetingFormat} meeting on ${startTime.toLocaleDateString()} at ${startTime.toLocaleTimeString()}${location ? ` at ${location}` : ""}`,
    },
  });

  // Save system message
  await prisma.message.create({
    data: {
      sessionId,
      role: "system",
      content: `Meeting confirmed: ${meetingFormat} on ${startTime.toLocaleDateString()} at ${startTime.toLocaleTimeString()}${meetLink ? `. Meet link: ${meetLink}` : ""}`,
    },
  });

  // Send confirmation emails
  const emailBody = buildConfirmationEmail({
    initiatorName: session.initiator.name || "The organizer",
    responderName: session.link.inviteeName || undefined,
    topic: session.link.topic || undefined,
    dateTime: startTime,
    duration: durationMin,
    format: meetingFormat,
    location,
    meetLink,
  });

  const emailRecipients = [initiatorEmail];
  if (responderEmail) emailRecipients.push(responderEmail);

  try {
    await resend.emails.send({
      from: "AgentEnvoy <noreply@agentenvoy.ai>",
      to: emailRecipients,
      subject: `Meeting Confirmed${session.link.topic ? `: ${session.link.topic}` : ""}`,
      html: emailBody,
    });
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
  });
}

function buildConfirmationEmail(params: {
  initiatorName: string;
  responderName?: string;
  topic?: string;
  dateTime: Date;
  duration: number;
  format: string;
  location?: string;
  meetLink?: string;
}) {
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 48px; margin-bottom: 8px;">✅</div>
        <h1 style="font-size: 24px; font-weight: 700; color: #1a1a2e; margin: 0;">Meeting Confirmed</h1>
      </div>
      <div style="background: #f8f8fc; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        ${params.topic ? `<p style="margin: 0 0 12px 0; font-size: 16px; font-weight: 600;">${params.topic}</p>` : ""}
        <p style="margin: 0 0 8px 0; color: #666;">📅 ${params.dateTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
        <p style="margin: 0 0 8px 0; color: #666;">🕐 ${params.dateTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} (${params.duration} min)</p>
        <p style="margin: 0 0 8px 0; color: #666;">📱 ${params.format.charAt(0).toUpperCase() + params.format.slice(1)}</p>
        ${params.location ? `<p style="margin: 0 0 8px 0; color: #666;">📍 ${params.location}</p>` : ""}
        ${params.meetLink ? `<p style="margin: 0;"><a href="${params.meetLink}" style="color: #6c5ce7; font-weight: 600;">Join Google Meet</a></p>` : ""}
      </div>
      <p style="text-align: center; font-size: 13px; color: #999;">
        Scheduled by <a href="https://agentenvoy.ai" style="color: #6c5ce7;">AgentEnvoy</a> — your AI negotiates so you don't have to.
      </p>
    </div>
  `;
}
