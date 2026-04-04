import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildKnowledgePreview } from "@/agent/administrator";

// GET /api/agent/knowledge
// Returns the host's knowledge base + a rendered preview
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      persistentKnowledge: true,
      situationalKnowledge: true,
      preferences: true,
      hostDirectives: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const preview = buildKnowledgePreview({
    preferences: (user.preferences as Record<string, unknown>) || {},
    directives: (user.hostDirectives as string[]) || [],
    persistentKnowledge: user.persistentKnowledge,
    situationalKnowledge: user.situationalKnowledge,
  });

  return NextResponse.json({
    persistentKnowledge: user.persistentKnowledge || "",
    situationalKnowledge: user.situationalKnowledge || "",
    preview,
  });
}

// PUT /api/agent/knowledge
// Update the host's knowledge base
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { persistentKnowledge, situationalKnowledge } = body;

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      ...(persistentKnowledge !== undefined && { persistentKnowledge }),
      ...(situationalKnowledge !== undefined && { situationalKnowledge }),
    },
  });

  return NextResponse.json({ status: "updated" });
}
