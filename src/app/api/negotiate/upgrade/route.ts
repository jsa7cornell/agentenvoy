import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// POST /api/negotiate/upgrade
// Flips a link from "single" to "group" mode
// Body: { linkId: string } or { sessionId: string }
export async function POST(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { linkId, sessionId } = body;

  if (!linkId && !sessionId) {
    return NextResponse.json(
      { error: "Missing linkId or sessionId" },
      { status: 400 }
    );
  }

  // Find the link
  let link;
  if (linkId) {
    link = await prisma.negotiationLink.findUnique({
      where: { id: linkId },
    });
  } else {
    const session = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      include: { link: true },
    });
    link = session?.link;
  }

  if (!link) {
    return NextResponse.json({ error: "Link not found" }, { status: 404 });
  }

  // Verify caller is the host
  if (link.userId !== authSession.user.id) {
    return NextResponse.json({ error: "Only the host can upgrade a link" }, { status: 403 });
  }

  // Idempotent — already group mode
  if (link.mode === "group") {
    return NextResponse.json({ status: "ok", mode: "group", linkId: link.id });
  }

  // Flip to group mode
  await prisma.negotiationLink.update({
    where: { id: link.id },
    data: { mode: "group" },
  });

  // Backfill: if there's an existing session with a guest, create a SessionParticipant for them
  const existingSessions = await prisma.negotiationSession.findMany({
    where: { linkId: link.id },
    include: { guest: true },
  });

  for (const sess of existingSessions) {
    // Check if participant already exists
    const existing = await prisma.sessionParticipant.findUnique({
      where: { sessionId: sess.id },
    });
    if (existing) continue;

    if (sess.hostId === authSession.user.id) {
      // Host's session — create host participant
      await prisma.sessionParticipant.create({
        data: {
          linkId: link.id,
          sessionId: sess.id,
          userId: sess.hostId,
          email: authSession.user.email || null,
          name: authSession.user.name || null,
          role: "host",
          status: "active",
        },
      });
    }

    if (sess.guestId || sess.guestEmail) {
      // Guest session — create guest participant
      // But this session might be the same as above (host + guest share one session in single mode)
      // For single mode, there's one session with both host and guest. We need a separate participant row.
      // Since sessionId is @unique on SessionParticipant, we can only have one per session.
      // In single mode, the session is shared — so we create the guest participant row only if
      // we didn't already create a host one for this session.
      const alreadyCreated = await prisma.sessionParticipant.findUnique({
        where: { sessionId: sess.id },
      });
      if (!alreadyCreated) {
        await prisma.sessionParticipant.create({
          data: {
            linkId: link.id,
            sessionId: sess.id,
            userId: sess.guestId || null,
            email: sess.guestEmail || link.inviteeEmail || null,
            name: link.inviteeName || null,
            role: "guest",
            status: sess.status === "agreed" ? "agreed" : "active",
          },
        });
      }
    }
  }

  return NextResponse.json({ status: "ok", mode: "group", linkId: link.id });
}
