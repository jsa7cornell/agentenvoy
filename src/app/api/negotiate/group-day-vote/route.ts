/**
 * POST /api/negotiate/group-day-vote
 *
 * Participant clicks a day cell in the GroupDayGrid. Records their
 * availability toggle in GroupCoordination.responses[].
 *
 * Body: { negotiationSessionId, date, available }
 *   negotiationSessionId — the participant's own NegotiationSession.id
 *   date                 — ISO date string "YYYY-MM-DD"
 *   available            — true = works for me, false = doesn't work
 *
 * Auth: none required — the link is public. The participant is identified
 * by their SessionParticipant row (matched to negotiationSessionId). If
 * the participant hasn't named themselves yet, their column shows as "Guest".
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const { negotiationSessionId, date, available } = await req.json() as {
      negotiationSessionId: string;
      date: string;
      available: boolean;
    };

    if (!negotiationSessionId || !date || typeof available !== "boolean") {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
    }

    // Load the session to find its link
    const session = await prisma.negotiationSession.findUnique({
      where: { id: negotiationSessionId },
      select: { linkId: true, hostId: true },
    });
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    // Find this participant's SessionParticipant row to get their name
    const participant = await prisma.sessionParticipant.findFirst({
      where: { sessionId: negotiationSessionId },
      select: { name: true, email: true },
    });
    const personLabel = participant?.name || participant?.email || `Guest (${negotiationSessionId.slice(-4)})`;

    // Find the GroupCoordination row via the link
    const gc = await prisma.groupCoordination.findFirst({
      where: { session: { linkId: session.linkId } },
      select: { id: true, sessionId: true, responses: true },
    });
    if (!gc) return NextResponse.json({ error: "GroupCoordination not found" }, { status: 404 });

    // Update this person's day votes in responses[].
    // Shape: { person, dayVotes: { "2026-05-13": true, "2026-05-20": false, ... }, ... }
    const existing = Array.isArray(gc.responses) ? gc.responses as Array<Record<string, unknown>> : [];
    const personEntry = existing.find((r) => r.person === personLabel) as Record<string, unknown> | undefined;
    const currentVotes = (personEntry?.dayVotes as Record<string, boolean>) ?? {};
    const updatedVotes = { ...currentVotes, [date]: available };

    const updatedResponses = personEntry
      ? existing.map((r) =>
          r.person === personLabel
            ? { ...r, dayVotes: updatedVotes, updatedAt: new Date().toISOString() }
            : r
        )
      : [...existing, { person: personLabel, dayVotes: updatedVotes, windows: [], preferences: {}, unavailable: [], updatedAt: new Date().toISOString() }];

    await prisma.groupCoordination.update({
      where: { id: gc.id },
      data: { responses: updatedResponses as unknown as import("@prisma/client").Prisma.InputJsonValue },
    });

    return NextResponse.json({ success: true, person: personLabel, date, available });
  } catch (err) {
    console.error("[group-day-vote]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
