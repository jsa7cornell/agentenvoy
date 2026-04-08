import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";

/**
 * POST /api/debug/force-resync
 * Clears the CalendarCache and ComputedSchedule for the current user,
 * forcing a full re-sync from Google on the next request.
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;

  // Delete all cached calendar data — next syncCalendar() call does a full fetch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deleted = await (prisma as any).calendarCache.deleteMany({ where: { userId } });

  // Also clear computed schedule so it recomputes with fresh events
  await invalidateSchedule(userId);

  return NextResponse.json({
    status: "ok",
    calendarCacheEntriesCleared: deleted.count,
    message: "Full re-sync will happen on next calendar access.",
  });
}
