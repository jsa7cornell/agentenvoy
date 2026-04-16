import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deleteCalendarEvent, invalidateSchedule } from "@/lib/calendar";

// POST /api/negotiate/reschedule
// Reschedule a confirmed meeting: removes the Google Calendar event (notifying
// attendees it needs to be rescheduled), releases holds, and resets the session
// back to active negotiation so a new time can be found.
// Only available to the host. Only valid for confirmed (agreed) sessions.
export async function POST(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { sessionId } = body;

  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const negotiation = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      holds: { where: { status: "active" }, select: { id: true, calendarEventId: true } },
    },
  });

  if (!negotiation) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (negotiation.hostId !== authSession.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (negotiation.status !== "agreed") {
    return NextResponse.json(
      { error: "Only confirmed meetings can be rescheduled." },
      { status: 400 }
    );
  }

  // 1. Delete the confirmed Google Calendar event, notifying attendees.
  if (negotiation.calendarEventId) {
    try {
      await deleteCalendarEvent(negotiation.hostId, negotiation.calendarEventId, {
        notifyAttendees: true,
      });
    } catch (e) {
      console.error("[reschedule] failed to delete confirmed calendar event:", e);
      // Non-blocking — proceed with DB cleanup regardless.
    }
  }

  // 2. Release any active holds (tentative blocking events).
  if (negotiation.holds.length > 0) {
    await Promise.all(
      negotiation.holds.map(async (hold) => {
        if (hold.calendarEventId) {
          try {
            await deleteCalendarEvent(negotiation.hostId, hold.calendarEventId);
          } catch (e) {
            console.warn(`[reschedule] failed to delete hold event ${hold.calendarEventId}:`, e);
          }
        }
      })
    );
    await prisma.hold.updateMany({
      where: { sessionId, status: "active" },
      data: { status: "released" },
    });
  }

  // 3. Invalidate schedule cache so the previously blocked slot opens back up.
  try {
    await invalidateSchedule(negotiation.hostId);
  } catch (e) {
    console.warn("[reschedule] schedule cache invalidation failed (non-blocking):", e);
  }

  // 4. Reset the session back to active negotiation.
  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: {
      status: "active",
      archived: false,
      statusLabel: "Rescheduling — finding a new time",
      agreedTime: null,
      agreedFormat: null,
      meetLink: null,
      calendarEventId: null,
    },
  });

  await prisma.message.create({
    data: {
      sessionId,
      role: "system",
      content:
        "The host has requested to reschedule this meeting. The previous time has been cancelled and attendees have been notified. A new time is being arranged.",
    },
  });

  return NextResponse.json({ ok: true });
}
