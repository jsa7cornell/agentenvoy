import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCalendarEventStatus } from "@/lib/calendar";

// GET /api/negotiate/gcal-status?sessionId=xxx
// Returns Google Calendar event status for a confirmed session.
// Host-only — guests do not need to see RSVP details.
export async function GET(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const negotiation = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      hostId: true,
      status: true,
      calendarEventId: true,
      guestEmail: true,
      link: { select: { inviteeEmail: true } },
    },
  });

  if (!negotiation) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (negotiation.hostId !== authSession.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (!negotiation.calendarEventId) {
    return NextResponse.json({ eventExists: false, guestOnInvite: false, guestResponseStatus: null });
  }

  const guestEmail = negotiation.guestEmail || negotiation.link.inviteeEmail || null;

  try {
    const status = await getCalendarEventStatus(
      negotiation.hostId,
      negotiation.calendarEventId,
      guestEmail
    );
    return NextResponse.json(status);
  } catch (e) {
    console.error("[gcal-status] error fetching calendar event:", e);
    return NextResponse.json({ error: "Calendar lookup failed" }, { status: 500 });
  }
}
