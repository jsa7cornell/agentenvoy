import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/negotiate/note
// Save a host note (:: prefix messages) — only the session host can do this
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json();
  const { sessionId, content } = body;

  if (!sessionId || !content) {
    return NextResponse.json(
      { error: "Missing sessionId or content" },
      { status: 400 }
    );
  }

  // Verify the user is the host of this session
  const negotiation = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
  });

  if (!negotiation || negotiation.hostId !== user.id) {
    return NextResponse.json(
      { error: "Not authorized — only the host can leave notes" },
      { status: 403 }
    );
  }

  // Save as a host_note message
  const message = await prisma.message.create({
    data: {
      sessionId,
      role: "host_note",
      content,
    },
  });

  return NextResponse.json({ id: message.id, status: "saved" });
}
