import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";

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

  return NextResponse.json({
    timezone: (explicit.timezone as string) ?? (prefs.timezone as string) ?? "America/Los_Angeles",
    businessHoursStart: (explicit.businessHoursStart as number) ?? 9,
    businessHoursEnd: (explicit.businessHoursEnd as number) ?? 18,
    blockedWindows: (explicit.blockedWindows as unknown[]) ?? [],
    currentLocation: (explicit.currentLocation as { label: string; until?: string }) ?? null,
    blackoutDays: (explicit.blackoutDays as string[]) ?? [],
    persistentKnowledge: user.persistentKnowledge ?? "",
    upcomingSchedulePreferences: user.upcomingSchedulePreferences ?? "",
  });
}

// PUT /api/tuner/preferences — save updated preferences from the tuner panel
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

  const updateData: Record<string, unknown> = {
    preferences: { ...prefs, explicit: newExplicit },
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

  return NextResponse.json({ success: true });
}
