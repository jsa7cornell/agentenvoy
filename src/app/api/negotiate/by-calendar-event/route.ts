import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// GET /api/negotiate/by-calendar-event?eventId=xxx
// Look up an AgentEnvoy session by Google Calendar event ID.
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

  const session = await prisma.negotiationSession.findFirst({
    where: {
      hostId: authSession.user.id,
      calendarEventId: eventId,
    },
    select: {
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
    },
  });

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
