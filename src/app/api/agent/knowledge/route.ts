import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { buildKnowledgePreview } from "@/agent/administrator";
import { invalidateSchedule } from "@/lib/calendar";
import { compilePreferenceRules } from "@/lib/scoring";
import type { UserPreferences } from "@/lib/scoring";

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
      upcomingSchedulePreferences: true,
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
    upcomingSchedulePreferences: user.upcomingSchedulePreferences,
  });

  const compiled = ((user.preferences as Record<string, unknown>)?.compiled ?? null) as { ambiguities?: string[] } | null;
  const prefs = (user.preferences as UserPreferences) || {};

  return NextResponse.json({
    persistentKnowledge: user.persistentKnowledge || "",
    upcomingSchedulePreferences: user.upcomingSchedulePreferences || "",
    preview,
    ambiguities: compiled?.ambiguities ?? [],
    activeCalendarIds: prefs.explicit?.activeCalendarIds ?? [],
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
  const { persistentKnowledge, upcomingSchedulePreferences } = body;

  // Save text fields first
  const user = await prisma.user.update({
    where: { id: session.user.id },
    data: {
      ...(persistentKnowledge !== undefined && { persistentKnowledge }),
      ...(upcomingSchedulePreferences !== undefined && { upcomingSchedulePreferences }),
    },
    select: { persistentKnowledge: true, upcomingSchedulePreferences: true, preferences: true },
  });

  // Compile free-text preferences into deterministic scheduling rules
  const prefs = (user.preferences as UserPreferences) || {};
  const tz = prefs.explicit?.timezone ?? prefs.timezone ?? "America/Los_Angeles";

  const compiled = await compilePreferenceRules(
    user.persistentKnowledge,
    user.upcomingSchedulePreferences,
    tz
  );

  // Store compiled rules in preferences.compiled
  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      preferences: { ...prefs, compiled } as unknown as Prisma.InputJsonValue,
    },
  });

  // Invalidate computed schedule so next request picks up new rules
  await invalidateSchedule(session.user.id);

  return NextResponse.json({ status: "updated", ambiguities: compiled.ambiguities });
}
