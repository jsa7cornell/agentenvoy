import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parsePreferences } from "@/agent/administrator";

// POST /api/agent/configure
// Update user preferences via natural language prompt
// This is the "agent setup" — the prompt IS the configuration
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { prompt } = body;

  if (!prompt) {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  }

  // Parse natural language into structured preferences
  const preferences = await parsePreferences(prompt);

  // Merge with existing preferences
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });

  const existingPrefs = (user?.preferences as Record<string, unknown>) || {};
  const mergedPrefs = { ...existingPrefs, ...preferences };

  await prisma.user.update({
    where: { id: session.user.id },
    data: { preferences: mergedPrefs as object },
  });

  return NextResponse.json({ preferences: mergedPrefs });
}
