import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/negotiate/directive
// Add a global host directive (::: messages) — shapes all future negotiations
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
  const { content, sessionId } = body;

  if (!content) {
    return NextResponse.json({ error: "Missing content" }, { status: 400 });
  }

  // Append to the user's hostDirectives array
  const existing = (user.hostDirectives as string[]) || [];
  const updated = [...existing, content];

  await prisma.user.update({
    where: { id: user.id },
    data: { hostDirectives: updated },
  });

  // Also save as a host_note on the session if sessionId provided (audit trail)
  if (sessionId) {
    await prisma.message.create({
      data: {
        sessionId,
        role: "host_note",
        content: `[DIRECTIVE] ${content}`,
      },
    });
  }

  return NextResponse.json({
    status: "saved",
    directiveCount: updated.length,
  });
}

// GET /api/negotiate/directive
// List all host directives for the current user
export async function GET() {
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

  return NextResponse.json({
    directives: (user.hostDirectives as string[]) || [],
  });
}
