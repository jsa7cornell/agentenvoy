/**
 * Data-repair endpoint — re-dispatch calendar.create_event for sessions that
 * were confirmed while EFFECT_MODE_CALENDAR was defaulting to dryrun.
 *
 * Context (2026-04-17): Phase 2 of the side-effect dispatcher shipped calendar
 * writes through dispatch(), but the EFFECT_MODE_CALENDAR env var was never
 * set in Vercel production. The dispatcher defaulted to `dryrun`, which
 * synthesizes a `dryrun-<uuid>` event ID and a `meet.google.com/dryrun-...`
 * meet link but never creates a real Google Calendar event.
 *
 * Every confirmed meeting from the Phase 2 deploy until John set the env var
 * has `calendarEventId LIKE 'dryrun-%'` — agreed in the DB, but not on
 * anyone's calendar. This endpoint lets the admin re-issue a real GCal event
 * for each affected session, one at a time, with full control over whether
 * attendees are notified.
 *
 * Safe to retry — if re-dispatch fails, the session keeps its dryrun-* ID
 * and can be retried again. On success, the session is updated with the
 * real eventId + meetLink.
 *
 * OAuth-gated to ADMIN_EMAIL; 404s for anyone else.
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { dispatch } from "@/lib/side-effects/dispatcher";

export const dynamic = "force-dynamic";

// GET — list sessions that need repair
export async function GET() {
  if (!(await isAdminSession())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const broken = await prisma.negotiationSession.findMany({
    where: {
      status: "agreed",
      archived: false,
      calendarEventId: { startsWith: "dryrun-" },
    },
    select: {
      id: true,
      title: true,
      guestName: true,
      guestEmail: true,
      agreedTime: true,
      agreedFormat: true,
      duration: true,
      calendarEventId: true,
      meetLink: true,
      host: { select: { id: true, name: true, email: true } },
      link: {
        select: { slug: true, code: true, topic: true, rules: true },
      },
    },
    orderBy: { agreedTime: "desc" },
  });

  return NextResponse.json({ sessions: broken });
}

// POST — re-dispatch calendar.create_event for a specific session
//
// Body: { sessionId: string, sendUpdates?: "all" | "none" | "externalOnly" }
//   sendUpdates defaults to "none" — admin decides whether to re-notify
//   the guest. Default is quiet so repeated repairs don't spam recipients.
export async function POST(req: NextRequest) {
  if (!(await isAdminSession())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { sessionId, sendUpdates } = body as {
    sessionId?: string;
    sendUpdates?: "all" | "none" | "externalOnly";
  };
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: { host: true, link: true },
  });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (!session.calendarEventId?.startsWith("dryrun-")) {
    return NextResponse.json(
      { error: `Session ${sessionId} does not have a dryrun-* eventId (got ${session.calendarEventId ?? "null"})` },
      { status: 400 }
    );
  }
  if (!session.agreedTime) {
    return NextResponse.json({ error: "Session has no agreedTime" }, { status: 400 });
  }

  const hostEmail = session.host.email;
  if (!hostEmail) {
    return NextResponse.json({ error: "Host has no email" }, { status: 400 });
  }

  const durationMin = session.duration ?? 30;
  const startTime = session.agreedTime;
  const endTime = new Date(startTime.getTime() + durationMin * 60 * 1000);
  const meetingFormat = session.agreedFormat ?? "video";

  const hostPrefs = session.host.preferences as Record<string, unknown> | null;
  const videoProvider = (hostPrefs?.videoProvider as string) || "google-meet";
  const useGoogleMeet = meetingFormat === "video" && videoProvider !== "zoom";

  const guestLabel = session.guestName || session.guestEmail || "guest";
  const hostLabel = session.host.name || "Host";
  const eventSummary = (() => {
    if (session.link.topic) return `${session.link.topic} — ${guestLabel}`;
    if (meetingFormat === "phone") return `Phone call: ${guestLabel} & ${hostLabel}`;
    return `Meeting with ${guestLabel}`;
  })();

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://agentenvoy.ai";
  const dealRoomUrl = session.link.code
    ? `${baseUrl}/meet/${session.link.slug}/${session.link.code}`
    : `${baseUrl}/meet/${session.link.slug}`;

  const attendeeEmails = [
    hostEmail,
    ...(session.guestEmail ? [session.guestEmail] : []),
  ];

  const linkRulesObj = (session.link.rules as Record<string, unknown> | null) || {};
  const linkLocation =
    typeof linkRulesObj.location === "string" && linkRulesObj.location.trim()
      ? linkRulesObj.location.trim()
      : null;

  const description = [
    `Scheduled via AgentEnvoy`,
    `Format: ${meetingFormat}`,
    ...(linkLocation ? [`Location: ${linkLocation}`] : []),
    "",
    `Need to change or cancel? ${dealRoomUrl}`,
  ].join("\n");

  const result = await dispatch({
    kind: "calendar.create_event",
    userId: session.hostId,
    summary: eventSummary,
    description,
    startTime,
    endTime,
    attendeeEmails,
    addMeetLink: useGoogleMeet,
    sessionId: session.id,
    sendUpdatesOverride: sendUpdates ?? "none",
    context: { purpose: "dryrun_repair", previousEventId: session.calendarEventId },
  });

  if (result.status !== "sent") {
    return NextResponse.json(
      {
        ok: false,
        dispatchStatus: result.status,
        dispatchMode: result.mode,
        error: result.error ?? "Dispatch did not return sent",
      },
      { status: 500 }
    );
  }

  if (!result.eventId || result.eventId.startsWith("dryrun-")) {
    return NextResponse.json(
      {
        ok: false,
        error: `Dispatch returned mode=${result.mode} eventId=${result.eventId}. EFFECT_MODE_CALENDAR must be live in this environment.`,
      },
      { status: 500 }
    );
  }

  const newMeetLink = result.meetLink ?? session.meetLink ?? null;
  await prisma.negotiationSession.update({
    where: { id: session.id },
    data: {
      calendarEventId: result.eventId,
      meetLink: newMeetLink,
    },
  });

  return NextResponse.json({
    ok: true,
    sessionId: session.id,
    previousEventId: session.calendarEventId,
    newEventId: result.eventId,
    newMeetLink,
    htmlLink: result.htmlLink,
    sendUpdates: sendUpdates ?? "none",
  });
}
