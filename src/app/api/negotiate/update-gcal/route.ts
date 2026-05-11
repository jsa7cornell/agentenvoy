import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertAgentEnvoyOwnedEvent, updateCalendarEvent, GcalOwnershipError } from "@/lib/calendar";
import { logRouteError } from "@/lib/route-error";
import { parseLinkParameters } from "@/lib/link-parameters";

// POST /api/negotiate/update-gcal
//
// Atomically patches a confirmed GCal event with edits from the deal-room.
// Called from MeetingCardConfirmedView's reschedule picker (and previously
// from the host-feed GcalUpdateCard, which the 2026-05-11 direct-patch
// decision retired).
//
// Auth: sessionId-only, same trust model as /api/negotiate/reschedule,
// /confirm, and /message — anyone holding the deal-room URL is trusted
// to act on the session (Q1 of the 2026-04-20 calendar-popup-ctas
// proposal). GCal API calls run against the host's stored credentials
// (session.hostId), not the caller's.
//
// Safety invariants:
//   1. Ownership gate: event must carry agentenvoySessionId == session.id
//      (assertAgentEnvoyOwnedEvent). Rejects if event was created outside AE.
//   2. Session guard: session must be "agreed" + have calendarEventId + not archived.
//   3. TOCTOU: DB status written with updateMany WHERE guard so concurrent
//      requests can't both succeed.
//   4. GCal call is OUTSIDE any DB transaction (B1 fix — avoids pool exhaustion).
//   5. Past-time guard: proposed startTime must be in the future.

const bodySchema = z.object({
  sessionId: z.string().min(1),
  proposed: z.object({
    location: z.string().optional(),
    format: z.enum(["phone", "video", "in-person"]).optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    duration: z.number().int().positive().optional(),
  }),
  notifyAttendees: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }
    const { sessionId, proposed, notifyAttendees } = parsed.data;

    // Load session — sessionId is the trust boundary (Q1 of the 2026-04-20
    // calendar-popup-ctas proposal). GCal calls run against session.hostId's
    // stored credentials regardless of who is calling, since the event lives
    // in the host's calendar.
    const session = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        hostId: true,
        status: true,
        calendarEventId: true,
        archived: true,
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (!session.calendarEventId) {
      return NextResponse.json({ error: "Session has no confirmed calendar event" }, { status: 400 });
    }
    if (session.status !== "agreed" || session.archived) {
      return NextResponse.json({ error: "Session is not in a confirmed state" }, { status: 409 });
    }

    // Past-time guard
    if (proposed.startTime) {
      const start = new Date(proposed.startTime);
      if (start <= new Date()) {
        return NextResponse.json({ error: "Proposed start time is in the past" }, { status: 400 });
      }
    }

    // Ownership check — event must carry this session's tag. Uses
    // session.hostId for the GCal client because the event lives in the
    // host's calendar, not the caller's.
    try {
      await assertAgentEnvoyOwnedEvent(session.hostId, session.calendarEventId, session.id);
    } catch (err) {
      if (err instanceof GcalOwnershipError) {
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      throw err;
    }

    // Build GCal changes (only include fields that are present in proposed)
    const gcalChanges: Parameters<typeof updateCalendarEvent>[3] = {};
    if (proposed.location !== undefined) gcalChanges.location = proposed.location;
    if (proposed.startTime !== undefined) gcalChanges.startTime = new Date(proposed.startTime);
    if (proposed.endTime !== undefined) {
      gcalChanges.endTime = new Date(proposed.endTime);
    } else if (proposed.startTime && proposed.duration) {
      gcalChanges.endTime = new Date(new Date(proposed.startTime).getTime() + proposed.duration * 60 * 1000);
    }

    // GCal call OUTSIDE any transaction (B1 — avoids holding pg connection open)
    const gcalResult = await updateCalendarEvent(
      session.hostId,
      session.calendarEventId,
      session.id,
      gcalChanges,
      { notifyAttendees },
    );

    // DB writes AFTER GCal succeeds — use updateMany WHERE guard (B2 — TOCTOU)
    const dbUpdates: Record<string, unknown> = {};
    if (proposed.location !== undefined) {
      dbUpdates.statusLabel = `Location updated to ${proposed.location}`;
    }
    if (proposed.startTime !== undefined) {
      // Set both: confirmedAt drives the legacy view; agreedTime is the
      // canonical read for the new MeetingCard (via session-load endpoint
      // → poll → confirmData.dateTime). Without agreedTime the card stays
      // on the old time even after a successful patch (reported 2026-05-11).
      dbUpdates.confirmedAt = new Date(proposed.startTime);
      dbUpdates.agreedTime = new Date(proposed.startTime);
    }
    if (proposed.duration !== undefined) {
      dbUpdates.duration = proposed.duration;
    }
    // Persist the updated htmlLink from GCal so future reads use the canonical
    // URL. Only overwrite when GCal returned a new link (patch may return null
    // for some update types — skip the write in that case to preserve the
    // previously-stored link).
    if (gcalResult.htmlLink) {
      dbUpdates.gcalHtmlLink = gcalResult.htmlLink;
    }

    if (Object.keys(dbUpdates).length > 0) {
      await prisma.negotiationSession.updateMany({
        where: { id: sessionId, status: "agreed", archived: false },
        data: dbUpdates as Parameters<typeof prisma.negotiationSession.updateMany>[0]["data"],
      });
    }

    // Mirror format change to link.parameters for personalized links
    if (proposed.format) {
      const sessionWithLink = await prisma.negotiationSession.findUnique({
        where: { id: sessionId },
        select: { link: { select: { id: true, type: true, parameters: true } } },
      });
      if (sessionWithLink?.link.type === "personalized") {
        const existing = parseLinkParameters(sessionWithLink.link.parameters);
        await prisma.negotiationLink.update({
          where: { id: sessionWithLink.link.id },
          data: { parameters: { ...existing, format: proposed.format } },
        });
      }
    }

    // Post a system message for the deal-room thread
    const changeSummary = [
      proposed.location ? `location: ${proposed.location}` : null,
      proposed.format ? `format: ${proposed.format}` : null,
      proposed.startTime ? `time: ${new Date(proposed.startTime).toISOString()}` : null,
    ].filter(Boolean).join(", ");

    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: "system",
        content: `Meeting updated by host: ${changeSummary}`,
      },
    });

    return NextResponse.json({
      success: true,
      eventId: gcalResult.eventId,
      htmlLink: gcalResult.htmlLink,
    });
  } catch (err) {
    logRouteError({
      route: "/api/negotiate/update-gcal",
      method: "POST",
      statusCode: 500,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
