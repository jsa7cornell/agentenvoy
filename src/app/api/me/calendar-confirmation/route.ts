import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * POST /api/me/calendar-confirmation
 * Body: {} (sentinel — endpoint just flips the flag to true)
 *
 * Stamps `preferences.explicit.calendarSelectionConfirmed = true`. Read by
 * `/api/me/scheduling-defaults` so FirstRunWelcome knows when to advance
 * past the calendar picker into the posture readback. Reset clears it
 * (reset re-seeds explicit from Google).
 */
export async function POST() {
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
  const prefs = (user.preferences as Record<string, unknown>) || {};
  const explicit = (prefs.explicit as Record<string, unknown>) || {};
  const next = {
    ...prefs,
    explicit: { ...explicit, calendarSelectionConfirmed: true },
  };
  await prisma.user.update({
    where: { id: user.id },
    data: { preferences: next as Prisma.InputJsonValue },
  });
  return NextResponse.json({ success: true });
}
