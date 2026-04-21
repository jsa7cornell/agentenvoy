import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { cancelSession } from "@/lib/cancel-pipeline";

// POST /api/negotiate/cancel
// Cancel a confirmed meeting. Thin wrapper over the shared cancelSession()
// pipeline — this route layers on the HTTP-specific concerns (session auth,
// "only confirmed meetings" business gate) and delegates the cascade
// (Google delete, hold release, schedule invalidation, state flip, system
// message) to src/lib/cancel-pipeline.ts so the agent action path behaves
// identically. See module docstring there for the why.
//
// Optional body: { sessionId, note }. The note is appended to the deal-room
// system message ("Note: <text>") so the guest can see the host's reason
// without an extra round-trip.
export async function POST(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { sessionId, note } = body ?? {};

  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  // Business gate: this host-initiated route is only valid on confirmed
  // sessions. The cancelSession() primitive itself is state-agnostic; the
  // gate lives here so agent/drift callers can cancel from other states.
  const gate = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: { hostId: true, status: true },
  });
  if (!gate) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (gate.hostId !== authSession.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (gate.status !== "agreed") {
    return NextResponse.json(
      { error: "Only confirmed meetings can be cancelled. Use archive for pending sessions." },
      { status: 400 }
    );
  }

  const result = await cancelSession({
    sessionId,
    hostId: authSession.user.id,
    initiator: "host",
    note: typeof note === "string" ? note : null,
    notifyAttendees: true,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Cancel failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, changed: result.changed ?? true });
}
