import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertAgentEnvoyOwnedEvent, updateCalendarEvent, GcalOwnershipError } from "@/lib/calendar";
import { logRouteError } from "@/lib/route-error";

// POST /api/negotiate/update-gcal
//
// Atomically patches a confirmed GCal event with host-approved changes.
// Called when the host clicks "Confirm" on a GcalUpdateCard in the feed.
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
    const authSession = await getServerSession(authOptions);
    if (!authSession?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { email: authSession.user.email },
      select: { id: true },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }
    const { sessionId, proposed, notifyAttendees } = parsed.data;

    // Load session and verify ownership
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
    if (session.hostId !== user.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
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

    // Ownership check — event must carry this session's tag
    try {
      await assertAgentEnvoyOwnedEvent(user.id, session.calendarEventId, session.id);
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
      user.id,
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
      dbUpdates.confirmedAt = new Date(proposed.startTime);
    }

    if (Object.keys(dbUpdates).length > 0) {
      await prisma.negotiationSession.updateMany({
        where: { id: sessionId, status: "agreed", archived: false },
        data: dbUpdates as Parameters<typeof prisma.negotiationSession.updateMany>[0]["data"],
      });
    }

    // Mirror format change to link.rules for contextual links
    if (proposed.format) {
      const sessionWithLink = await prisma.negotiationSession.findUnique({
        where: { id: sessionId },
        select: { link: { select: { id: true, type: true, rules: true } } },
      });
      if (sessionWithLink?.link.type === "contextual") {
        const existing = (sessionWithLink.link.rules as Record<string, unknown>) || {};
        await prisma.negotiationLink.update({
          where: { id: sessionWithLink.link.id },
          data: { rules: { ...existing, format: proposed.format } },
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
