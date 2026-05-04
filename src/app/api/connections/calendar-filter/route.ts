import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule, invalidateCalendarListCache } from "@/lib/calendar";
import { reconcileEventsWatches } from "@/lib/google-watch";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

// PUT /api/connections/calendar-filter
// Body: { activeCalendarIds: string[] }
// Empty array = use all calendars
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { activeCalendarIds } = await req.json();
  if (!Array.isArray(activeCalendarIds)) {
    return NextResponse.json({ error: "activeCalendarIds must be an array" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });
  const prefs = (user?.preferences as UserPreferences) || {};

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      preferences: {
        ...prefs,
        explicit: {
          ...prefs.explicit,
          activeCalendarIds: activeCalendarIds.length > 0 ? activeCalendarIds : undefined,
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Invalidate schedule + calendarList cache so next sync fetches the
  // updated list from Google (Wedge A — proposal 2026-05-02_picker-load-perf).
  await invalidateSchedule(session.user.id);
  await invalidateCalendarListCache(session.user.id);

  // Reconcile watch channels to match the new activeCalendarIds set.
  // Fire-and-forget: watch registration failures are logged but never surface
  // to the user — the polling fallback remains in place.
  void reconcileEventsWatches(session.user.id, activeCalendarIds).catch((e) =>
    console.error("[calendar-filter] reconcileEventsWatches failed:", e),
  );

  return NextResponse.json({ status: "updated" });
}
