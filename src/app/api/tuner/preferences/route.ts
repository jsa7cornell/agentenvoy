import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";
import { compilePreferenceRules } from "@/lib/scoring";

// GET /api/tuner/preferences — fetch current user preferences for the tuner panel
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: {
      id: true,
      preferences: true,
      persistentKnowledge: true,
      upcomingSchedulePreferences: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const prefs = (user.preferences as Record<string, unknown>) || {};
  const explicit = (prefs.explicit as Record<string, unknown>) || {};
  const compiled = (prefs as Record<string, unknown>).compiled as Record<string, unknown> | undefined;

  return NextResponse.json({
    timezone: (explicit.timezone as string) ?? (prefs.timezone as string) ?? "America/Los_Angeles",
    businessHoursStart: (explicit.businessHoursStart as number) ?? 9,
    businessHoursEnd: (explicit.businessHoursEnd as number) ?? 18,
    blockedWindows: (explicit.blockedWindows as unknown[]) ?? [],
    currentLocation: (explicit.currentLocation as { label: string; until?: string }) ?? null,
    blackoutDays: (explicit.blackoutDays as string[]) ?? [],
    persistentKnowledge: user.persistentKnowledge ?? "",
    upcomingSchedulePreferences: user.upcomingSchedulePreferences ?? "",
    compiledRules: compiled ?? null,
  });
}

// PUT /api/tuner/preferences — save updated preferences, compile, and refresh calendar
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, preferences: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json();
  const {
    timezone,
    businessHoursStart,
    businessHoursEnd,
    blockedWindows,
    currentLocation,
    blackoutDays,
    persistentKnowledge,
    upcomingSchedulePreferences,
  } = body;

  const prefs = (user.preferences as Record<string, unknown>) || {};
  const explicit = (prefs.explicit as Record<string, unknown>) || {};

  const newExplicit: Record<string, unknown> = { ...explicit };

  if (timezone !== undefined) newExplicit.timezone = timezone;
  if (businessHoursStart !== undefined) newExplicit.businessHoursStart = businessHoursStart;
  if (businessHoursEnd !== undefined) newExplicit.businessHoursEnd = businessHoursEnd;
  if (blockedWindows !== undefined) newExplicit.blockedWindows = blockedWindows;
  if (blackoutDays !== undefined) newExplicit.blackoutDays = blackoutDays;

  if (currentLocation !== undefined) {
    if (currentLocation === null) {
      delete newExplicit.currentLocation;
    } else {
      newExplicit.currentLocation = currentLocation;
    }
  }

  // Compile free-text preferences into deterministic rules
  const tz = (timezone as string) ?? (newExplicit.timezone as string) ?? "America/Los_Angeles";
  let compiledRules = null;
  try {
    compiledRules = await compilePreferenceRules(
      persistentKnowledge ?? null,
      upcomingSchedulePreferences ?? null,
      tz
    );
  } catch (e) {
    console.error("[tuner/preferences] Compile failed:", e);
    // Non-fatal — save prefs anyway, just skip compilation
  }

  const newPrefs: Record<string, unknown> = {
    ...prefs,
    explicit: newExplicit,
  };
  if (compiledRules) {
    newPrefs.compiled = compiledRules;
  }

  const updateData: Record<string, unknown> = {
    preferences: newPrefs as Parameters<typeof prisma.user.update>[0]["data"]["preferences"],
    lastCalibratedAt: new Date(),
  };

  if (persistentKnowledge !== undefined) updateData.persistentKnowledge = persistentKnowledge;
  if (upcomingSchedulePreferences !== undefined) updateData.upcomingSchedulePreferences = upcomingSchedulePreferences;

  await prisma.user.update({
    where: { id: user.id },
    data: updateData as Parameters<typeof prisma.user.update>[0]["data"],
  });

  // Invalidate computed schedule so calendar refreshes with new preferences
  await invalidateSchedule(user.id);

  return NextResponse.json({ success: true, compiledRules });
}
