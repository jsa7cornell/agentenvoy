/**
 * POST /api/negotiate/session/timezone
 *
 * Updates a session's `guestTimezone` when the human guest elects to switch
 * the thread to their own timezone via the TZ recovery banner (Slice 7).
 *
 * Body: { sessionId: string, timezone: string }
 *
 * The timezone must be a valid IANA zone. This is the ONLY place (besides the
 * initial session-create) that writes guestTimezone — we deliberately keep
 * the write path narrow so we don't accidentally flip the thread's primary
 * TZ from LLM actions or other flows.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** Validate an IANA timezone string without actually changing anything. */
function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    // Intl throws RangeError on invalid zones.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let body: { sessionId?: unknown; timezone?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { sessionId, timezone } = body;

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  if (!isValidIanaTimezone(timezone)) {
    return NextResponse.json(
      { error: "Invalid or missing IANA timezone" },
      { status: 400 },
    );
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: { id: true, guestTimezone: true, status: true },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Don't allow TZ updates to agreed/confirmed sessions — the meeting is
  // already locked in. The banner shouldn't surface there anyway, but
  // belt-and-suspenders.
  if (session.status === "agreed") {
    return NextResponse.json(
      { error: "Cannot change timezone of a confirmed session" },
      { status: 409 },
    );
  }

  // No-op when the requested TZ already matches — return current state.
  if (session.guestTimezone === timezone) {
    return NextResponse.json({
      sessionTimezone: session.guestTimezone,
      changed: false,
    });
  }

  const updated = await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: { guestTimezone: timezone },
    select: { guestTimezone: true },
  });

  console.log(
    `[negotiate/session/timezone] sessionId=${sessionId} guestTimezone ${session.guestTimezone ?? "(unset)"} → ${updated.guestTimezone}`,
  );

  return NextResponse.json({
    sessionTimezone: updated.guestTimezone,
    changed: true,
  });
}
