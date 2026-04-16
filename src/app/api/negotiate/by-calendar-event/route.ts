import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// GET /api/negotiate/by-calendar-event?eventId=xxx[&eventStart=ISO]
// Look up an AgentEnvoy session by Google Calendar event ID.
// Falls back to matching by agreedTime (±2 min) for sessions confirmed before
// calendarEventId was added to the schema (calendarEventId was null).
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

  // Primary lookup: by calendarEventId
  let session = await prisma.negotiationSession.findFirst({
    where: {
      hostId: authSession.user.id,
      calendarEventId: eventId,
    },
    select: selectFields,
  });

  // Fallback: for old sessions where calendarEventId was never set, match by
  // agreedTime within ±2 minutes of the event start time.
  if (!session) {
    const eventStartParam = req.nextUrl.searchParams.get("eventStart");
    if (eventStartParam) {
      const eventStart = new Date(eventStartParam);
      if (!isNaN(eventStart.getTime())) {
        session = await prisma.negotiationSession.findFirst({
          where: {
            hostId: authSession.user.id,
            status: "agreed",
            calendarEventId: null,
            agreedTime: {
              gte: new Date(eventStart.getTime() - 2 * 60 * 1000),
              lte: new Date(eventStart.getTime() + 2 * 60 * 1000),
            },
          },
          select: selectFields,
        });
      }
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
