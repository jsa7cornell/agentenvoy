/**
 * POST /api/negotiate/session/viewer-timezone
 *
 * Writes `NegotiationSession.viewerTimezone` — the picker-authoritative IANA
 * timezone the viewer (typically the guest) is currently operating in. Called
 * from the deal-room calendar card in two places:
 *
 *   1. First card render — seeds with the default (detected-guest-tz if ≠ host,
 *      else host tz). Ensures the column is never null after first load so the
 *      dual-tz trigger in composer.ts (`viewerTimezone !== hostTimezone`) is
 *      always well-defined.
 *   2. Every picker tap — picker overrides browser as the source of truth for
 *      "which clock this guest is operating in" for the rest of the session.
 *
 * Idempotent: if the stored value already matches the requested value, returns
 * { changed: false } with a 200. Allowed on any session status (unlike
 * `/timezone` which blocks agreed sessions) because the guest may re-view a
 * confirmed session in a different tz and the card should still relabel.
 *
 * Body: { sessionId: string, timezone: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
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
    select: { id: true, viewerTimezone: true },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.viewerTimezone === timezone) {
    return NextResponse.json({
      viewerTimezone: session.viewerTimezone,
      changed: false,
    });
  }

  const updated = await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: { viewerTimezone: timezone },
    select: { viewerTimezone: true },
  });

  console.log(
    `[negotiate/session/viewer-timezone] sessionId=${sessionId} viewerTimezone ${session.viewerTimezone ?? "(unset)"} → ${updated.viewerTimezone}`,
  );

  return NextResponse.json({
    viewerTimezone: updated.viewerTimezone,
    changed: true,
  });
}
