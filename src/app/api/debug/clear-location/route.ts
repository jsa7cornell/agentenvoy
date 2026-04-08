import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

/**
 * POST /api/debug/clear-location
 * Clears preferences.explicit.currentLocation for the current user.
 * Use when Envoy has saved a stale travel location that is no longer accurate.
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });

  const prefs = (user?.preferences as UserPreferences) || {};
  const { currentLocation, ...explicitWithout } = (prefs.explicit || {}) as Record<string, unknown>;
  void currentLocation;

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      preferences: {
        ...prefs,
        explicit: explicitWithout,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await invalidateSchedule(session.user.id);

  return NextResponse.json({ status: "ok", message: "currentLocation cleared" });
}
