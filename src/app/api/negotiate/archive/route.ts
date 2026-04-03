import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// PATCH /api/negotiate/archive
// Archive or unarchive a session
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { sessionId, archived } = body;

  if (!sessionId || typeof archived !== "boolean") {
    return NextResponse.json(
      { error: "Missing sessionId or archived boolean" },
      { status: 400 }
    );
  }

  const negotiationSession = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
  });

  if (!negotiationSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Only the host can archive
  if (negotiationSession.hostId !== session.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Only allow archiving agreed/expired sessions or past events
  if (archived) {
    const isPast =
      negotiationSession.agreedTime &&
      new Date(negotiationSession.agreedTime) < new Date();
    const isClosedStatus =
      negotiationSession.status === "agreed" ||
      negotiationSession.status === "expired";

    if (!isPast && !isClosedStatus) {
      return NextResponse.json(
        { error: "Can only archive completed or past events" },
        { status: 400 }
      );
    }
  }

  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: { archived },
  });

  return NextResponse.json({ ok: true, archived });
}
