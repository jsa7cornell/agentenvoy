import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deleteCalendarEvent, invalidateSchedule } from "@/lib/calendar";

// POST /api/negotiate/reschedule
// Reschedule a confirmed meeting: removes the Google Calendar event (notifying
// attendees it needs to be rescheduled), releases holds, and resets the
// session back to active negotiation so a new time can be found.
//
// Callable by BOTH host and guest. Per the 2026-04-20 calendar-popup-ctas
// proposal (Q1 decision): guests auth by sessionId alone — symmetric with
// /api/negotiate/message and /api/negotiate/confirm. Anyone holding the
// deal-room URL is trusted to act on the session. The initiator label only
// changes the system-message wording + statusLabel; the mechanical cascade
// is identical either way.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { sessionId } = body ?? {};

  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const negotiation = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      holds: { where: { status: "active" }, select: { id: true, calendarEventId: true } },
      link: { select: { inviteeName: true } },
    },
  });

  if (!negotiation) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (negotiation.status !== "agreed") {
    return NextResponse.json(
      { error: "Only confirmed meetings can be rescheduled." },
      { status: 400 }
    );
  }

  // Distinguish host vs. guest caller purely for labelling. Host = logged in
  // as the session's host user. Everyone else = guest (trust by sessionId).
  const authSession = await getServerSession(authOptions);
  const isHost = authSession?.user?.id === negotiation.hostId;
  const initiator: "host" | "guest" = isHost ? "host" : "guest";

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
  const statusLabel = isHost
    ? "Rescheduling — finding a new time"
    : negotiation.link.inviteeName
    ? `Rescheduling — ${negotiation.link.inviteeName} finding a new time`
    : "Rescheduling — guest finding a new time";

  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: {
      status: "active",
      archived: false,
      statusLabel,
      agreedTime: null,
      agreedFormat: null,
      meetLink: null,
      calendarEventId: null,
    },
  });

  const systemContent = isHost
    ? "The host has requested to reschedule this meeting. The previous time has been cancelled and attendees have been notified. A new time is being arranged."
    : "The guest has requested to reschedule this meeting. The previous time has been cancelled and attendees have been notified. A new time is being arranged.";

  await prisma.message.create({
    data: {
      sessionId,
      role: "system",
      content: systemContent,
    },
  });

  return NextResponse.json({ ok: true, initiator });
}
