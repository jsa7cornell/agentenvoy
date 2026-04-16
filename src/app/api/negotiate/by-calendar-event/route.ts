import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getGoogleCalendarClient } from "@/lib/calendar";

// GET /api/negotiate/by-calendar-event?eventId=xxx
// Look up an AgentEnvoy session by Google Calendar event ID.
//
// Lookup chain (most reliable → least):
//  1. DB: NegotiationSession.calendarEventId = eventId  (fast, works for all new sessions)
//  2. GCal extended properties: fetch the event and read
//     extendedProperties.private.agentenvoySessionId  (reliable for any session created
//     after this field was added, even if calendarEventId was later cleared)
//
// Returns null if no matching session — caller treats the event as a plain calendar event.
export async function GET(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eventId = req.nextUrl.searchParams.get("eventId");
  if (!eventId) {
    return NextResponse.json({ error: "Missing eventId" }, { status: 400 });
  }

  const selectFields = {
    id: true,
    status: true,
    archived: true,
    title: true,
    agreedTime: true,
    agreedFormat: true,
    duration: true,
    meetLink: true,
    guestEmail: true,
    link: {
      select: {
        slug: true,
        code: true,
        inviteeName: true,
        inviteeEmail: true,
      },
    },
  };

  // Step 1: Primary DB lookup by calendarEventId
  let session = await prisma.negotiationSession.findFirst({
    where: {
      hostId: authSession.user.id,
      calendarEventId: eventId,
    },
    select: selectFields,
  });

  // Step 2: Fallback — fetch the GCal event and read the embedded session ID
  // from extendedProperties. This is set by createCalendarEvent() for every
  // new confirmed session and is reliable even if calendarEventId was null.
  if (!session) {
    try {
      const calendar = await getGoogleCalendarClient(authSession.user.id);
      const { data: gcalEvent } = await calendar.events.get({
        calendarId: "primary",
        eventId,
      });
      const embeddedSessionId =
        gcalEvent.extendedProperties?.private?.agentenvoySessionId;
      if (embeddedSessionId) {
        session = await prisma.negotiationSession.findFirst({
          where: {
            id: embeddedSessionId,
            hostId: authSession.user.id,
          },
          select: selectFields,
        });
      }
    } catch {
      // GCal fetch failed (event not found, no token, etc.) — fall through to null
    }
  }

  if (!session) {
    return NextResponse.json({ session: null });
  }

  const dealRoomUrl = session.link.code
    ? `/meet/${session.link.slug}/${session.link.code}`
    : `/meet/${session.link.slug}`;

  return NextResponse.json({
    session: {
      ...session,
      guestEmail: session.guestEmail || session.link.inviteeEmail || null,
      guestName: session.link.inviteeName || null,
      dealRoomUrl,
    },
  });
}
