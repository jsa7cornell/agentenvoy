import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildIcs } from "@/lib/ics";

// GET /api/negotiate/ics?sessionId=...
//
// Returns a text/calendar (.ics) file for an agreed meeting. Used by the
// degrade-not-block fallback (T3c): when a host hasn't granted
// `calendar.events` write access, we still produced a confirmed booking,
// but couldn't put it on their Google Calendar. This route hands them
// (or the guest) a file they can drop into any calendar client.
//
// Public by sessionId — same access shape as the rest of the deal-room
// reads. The file contents reveal nothing the deal-room participants
// don't already see.
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      agreedTime: true,
      duration: true,
      agreedFormat: true,
      format: true,
      meetLink: true,
      guestEmail: true,
      host: { select: { name: true, email: true } },
      link: { select: { inviteeName: true } },
    },
  });

  if (!session?.agreedTime) {
    return NextResponse.json(
      { error: "Session not agreed yet" },
      { status: 404 },
    );
  }

  const start = session.agreedTime;
  const durationMin = session.duration ?? 30;
  const end = new Date(start.getTime() + durationMin * 60_000);
  const fmt = session.agreedFormat ?? session.format ?? "video";
  const summary = session.link.inviteeName
    ? `${session.host.name ?? "Meeting"} ⇄ ${session.link.inviteeName}`
    : `Meeting with ${session.host.name ?? "AgentEnvoy"}`;

  const ics = buildIcs({
    uid: session.id,
    startUtc: start,
    endUtc: end,
    summary,
    description: `Scheduled via AgentEnvoy. Format: ${fmt}.`,
    meetLink: session.meetLink,
    organizer: session.host.email
      ? { name: session.host.name, email: session.host.email }
      : undefined,
    attendees: session.guestEmail
      ? [{ name: session.link.inviteeName, email: session.guestEmail }]
      : [],
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="agentenvoy-${session.id}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
