import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule, CalendarEvent } from "@/lib/calendar";

export async function GET(req: NextRequest) {
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

  const schedule = await getOrComputeSchedule(user.id);

  // Determine week window
  const weekStartParam = req.nextUrl.searchParams.get("weekStart");
  let weekStart: Date;
  if (weekStartParam) {
    weekStart = new Date(weekStartParam + "T00:00:00");
  } else {
    // Default to current Sunday
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    weekStart = new Date(now);
    weekStart.setDate(now.getDate() - day);
    weekStart.setHours(0, 0, 0, 0);
  }
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  // Filter slots to the requested week
  const slots = schedule.slots.filter((s) => {
    const t = new Date(s.start).getTime();
    return t >= weekStart.getTime() && t < weekEnd.getTime();
  });

  // Filter events to the requested week (include events that overlap)
  const events = schedule.events
    .filter((e) => {
      const eStart = new Date(e.start).getTime();
      const eEnd = new Date(e.end).getTime();
      return eEnd > weekStart.getTime() && eStart < weekEnd.getTime();
    })
    .map((e) => serializeEvent(e));

  // Build locationByDay from workingLocation events + preferences
  const prefs = (user.preferences as Record<string, unknown>) || {};
  const explicit = (prefs.explicit as Record<string, unknown>) || {};
  const currentLocation = explicit.currentLocation as { label: string; until?: string } | undefined;

  const locationByDay: Record<string, string | null> = {};
  for (let d = 0; d < 7; d++) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + d);
    const dayStr = day.toISOString().slice(0, 10);

    // Check workingLocation events for this day
    const wlEvent = schedule.events.find((e) => {
      if (e.eventType !== "workingLocation") return false;
      const eStart = new Date(e.start).getTime();
      const eEnd = new Date(e.end).getTime();
      const dayStart = day.getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      return eStart < dayEnd && eEnd > dayStart;
    });

    if (wlEvent?.summary) {
      locationByDay[dayStr] = wlEvent.summary;
    } else if (currentLocation?.label) {
      // Check if currentLocation is still valid (not expired)
      if (!currentLocation.until || currentLocation.until >= dayStr) {
        locationByDay[dayStr] = currentLocation.label;
      } else {
        locationByDay[dayStr] = null;
      }
    } else {
      locationByDay[dayStr] = null;
    }
  }

  return NextResponse.json({
    events,
    slots,
    locationByDay,
    timezone: schedule.timezone,
    connected: schedule.connected,
    calendars: schedule.calendars,
  });
}

function serializeEvent(e: CalendarEvent) {
  return {
    id: e.id,
    summary: e.summary,
    start: e.start instanceof Date ? e.start.toISOString() : e.start,
    end: e.end instanceof Date ? e.end.toISOString() : e.end,
    calendar: e.calendar,
    location: e.location,
    attendeeCount: e.attendeeCount,
    responseStatus: e.responseStatus,
    isAllDay: e.isAllDay,
    isRecurring: e.isRecurring,
    isTransparent: e.isTransparent,
    eventType: e.eventType,
  };
}
