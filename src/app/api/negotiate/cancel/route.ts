import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deleteCalendarEvent, invalidateSchedule } from "@/lib/calendar";

// POST /api/negotiate/cancel
// Cancel a meeting: deletes the confirmed Google Calendar event (notifying
// all attendees), releases any active holds, and marks the session cancelled.
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
      { error: "Only confirmed meetings can be cancelled. Use archive for pending sessions." },
      { status: 400 }
    );
  }

  // 1. Delete the confirmed Google Calendar event (notifies all attendees).
  if (negotiation.calendarEventId) {
    try {
      await deleteCalendarEvent(negotiation.hostId, negotiation.calendarEventId, {
        notifyAttendees: true,
      });
    } catch (e) {
      console.error("[cancel] failed to delete confirmed calendar event:", e);
      // Non-blocking — proceed with DB cleanup regardless.
    }
  }

  // 2. Release any active holds (tentative calendar events).
  if (negotiation.holds.length > 0) {
    await Promise.all(
      negotiation.holds.map(async (hold) => {
        if (hold.calendarEventId) {
          try {
            await deleteCalendarEvent(negotiation.hostId, hold.calendarEventId);
          } catch (e) {
            console.warn(`[cancel] failed to delete hold event ${hold.calendarEventId}:`, e);
          }
        }
      })
    );
    await prisma.hold.updateMany({
      where: { sessionId, status: "active" },
      data: { status: "released" },
    });
  }

  // 3. Invalidate schedule cache so the slot opens back up immediately.
  try {
    await invalidateSchedule(negotiation.hostId);
  } catch (e) {
    console.warn("[cancel] schedule cache invalidation failed (non-blocking):", e);
  }

  // 4. Mark session as cancelled + archived, add a system message.
  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: {
      status: "cancelled",
      archived: true,
      statusLabel: "Cancelled by host",
    },
  });

  await prisma.message.create({
    data: {
      sessionId,
      role: "system",
      content: "This meeting was cancelled by the host.",
    },
  });

  return NextResponse.json({ ok: true });
}
