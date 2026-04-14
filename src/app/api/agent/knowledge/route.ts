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
    phone: prefs.explicit?.phone || prefs.phone || "",
    videoProvider: prefs.explicit?.videoProvider || prefs.videoProvider || "google-meet",
    zoomLink: prefs.explicit?.zoomLink || prefs.zoomLink || "",
    defaultDuration: prefs.explicit?.defaultDuration || prefs.defaultDuration || 30,
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
  const { persistentKnowledge, upcomingSchedulePreferences, phone, videoProvider, zoomLink, defaultDuration } = body;

  // If meeting settings are being updated, save them to preferences first
  const hasMeetingSettings = phone !== undefined || videoProvider !== undefined || zoomLink !== undefined || defaultDuration !== undefined;
  if (hasMeetingSettings) {
    const currentUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { preferences: true },
    });
    const currentPrefs = (currentUser?.preferences as Record<string, unknown>) || {};
    const updates: Record<string, unknown> = {};
    if (phone !== undefined) updates.phone = phone || null;
    if (videoProvider !== undefined) updates.videoProvider = videoProvider || "google-meet";
    if (zoomLink !== undefined) updates.zoomLink = zoomLink || null;
    if (defaultDuration !== undefined) updates.defaultDuration = defaultDuration || 30;
    await prisma.user.update({
      where: { id: session.user.id },
      data: {
        preferences: { ...currentPrefs, ...updates } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Save text fields
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
