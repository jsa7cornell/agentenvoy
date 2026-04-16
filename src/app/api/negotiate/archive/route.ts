import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deleteCalendarEvent } from "@/lib/calendar";

// PATCH /api/negotiate/archive
// Archive (or unarchive) a session.
//
// Archiving keeps the confirmed Google Calendar event intact — the meeting
// still happens, the host just wants it out of their active deal list.
// BUT: any active holds (tentative blocking events) are always released on
// archive, since a pending session that's being archived won't be confirmed
// and those tentative blocks should free up.
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { sessionId, archived } = body;

  if (!sessionId || typeof archived !== "boolean") {
    return NextResponse.json(
      { error: "Missing sessionId or archived boolean" },
      { status: 400 }
    );
  }

  const negotiationSession = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      holds: { where: { status: "active" }, select: { id: true, calendarEventId: true } },
    },
  });

  if (!negotiationSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Only the host can archive
  if (negotiationSession.hostId !== session.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // When archiving, release any active holds — tentative calendar blocks have
  // no business sitting on the host's calendar once a session is closed.
  if (archived && negotiationSession.holds.length > 0) {
    await Promise.all(
      negotiationSession.holds.map(async (hold) => {
        if (hold.calendarEventId) {
          try {
            await deleteCalendarEvent(negotiationSession.hostId, hold.calendarEventId);
          } catch (e) {
            console.warn(`[archive] failed to delete hold event ${hold.calendarEventId}:`, e);
          }
        }
      })
    );
    await prisma.hold.updateMany({
      where: { sessionId, status: "active" },
      data: { status: "released" },
    });
  }

  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: { archived },
  });

  return NextResponse.json({ ok: true, archived });
}
