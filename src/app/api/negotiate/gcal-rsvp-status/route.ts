/**
 * GET /api/negotiate/gcal-rsvp-status?sessionId=xxx
 *
 * Returns GoogleCalendarStatus for the requesting viewer (host or guest).
 * Drives MeetingCardCalendarRow + the calendar-action slot in MeetingCardActions.
 *
 * - Host viewer: returns guest's RSVP as `otherPartyStatus`
 * - Guest viewer: returns own RSVP as `viewerStatus`
 * - Anonymous viewer: 401 — UI should suppress the row entirely (per § 3.14)
 *
 * GUEST-UI ONLY in Phase 1 — never crosses MCP wire (per spec § 6.1, AP5c
 * pre-committed for any future wire surface).
 *
 * Cache: 5 min private (rsvp can change frequently; balance freshness vs API quota).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCalendarEventStatus } from "@/lib/calendar";
import { getRsvpStatus } from "@/lib/gcal/getRsvpStatus";

export async function GET(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  if (!authSession?.user?.id) {
    // Anonymous — UI handles by suppressing the calendar row (§ 3.14).
    // Surfacing 401 here lets the client distinguish "not logged in"
    // from "no event."
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
      createdAt: true,
      link: { select: { inviteeEmail: true } },
    },
  });

  if (!negotiation) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const isHost = negotiation.hostId === authSession.user.id;
  const viewerEmail = authSession.user.email ?? null;
  const guestEmail = negotiation.guestEmail || negotiation.link.inviteeEmail || null;

  // Guest must match either the negotiation's guestEmail or the link's inviteeEmail
  const isGuest = !isHost && !!viewerEmail && !!guestEmail
    && viewerEmail.toLowerCase() === guestEmail.toLowerCase();

  if (!isHost && !isGuest) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!negotiation.calendarEventId) {
    // No GCal event yet — no status to render
    return NextResponse.json({ status: null });
  }

  try {
    const eventStatus = await getCalendarEventStatus(
      negotiation.hostId,
      negotiation.calendarEventId,
      guestEmail
    );

    // Check whether the guest has connected their own calendar.
    // For Phase 1: derive from session — if guest is logged in but their
    // RSVP doesn't appear in the event, treat as connectPromptEligible.
    // (Future: explicit calendarConnected flag from user settings.)
    const connectPromptEligible = isGuest && !eventStatus.guestResponseStatus;

    const rsvpStatus = getRsvpStatus({
      eventStatus,
      viewerEmail,
      viewerRole: isHost ? "host" : "guest",
      inviteSentAt: negotiation.createdAt,
      connectPromptEligible,
    });

    return NextResponse.json(
      { status: rsvpStatus },
      {
        headers: {
          "Cache-Control": "private, max-age=300", // 5 min
        },
      }
    );
  } catch (e) {
    console.error("[gcal-rsvp-status] error fetching calendar event:", e);
    return NextResponse.json({ error: "Calendar lookup failed" }, { status: 500 });
  }
}
