import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule, CalendarEvent } from "@/lib/calendar";
import { type AvailabilityRule, compileOfficeHoursLinks } from "@/lib/availability-rules";
import { applyOfficeHoursWindow } from "@/lib/office-hours";
import type { EventProtectionOverride } from "@/lib/scoring";

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

  // Read prefs once — used for both office-hours transforms and locationByDay.
  const prefs = (user.preferences as Record<string, unknown>) || {};
  const explicit = (prefs.explicit as Record<string, unknown>) || {};
  const structuredRules = (explicit.structuredRules as AvailabilityRule[] | undefined) ?? [];
  const eventProtectionOverrides = (explicit.eventProtectionOverrides as EventProtectionOverride[] | undefined) ?? [];
  // Per-event resolution: an explicit instance override wins over a series
  // override for the same underlying recurring master.
  function resolveOverride(e: CalendarEvent): { score: number; scope: "instance" | "series" } | null {
    let inst: EventProtectionOverride | undefined;
    let series: EventProtectionOverride | undefined;
    for (const o of eventProtectionOverrides) {
      if (o.eventId === e.id && (o.scope ?? "instance") === "instance") inst = o;
      else if (o.scope === "series" && e.recurringEventId && o.eventId === e.recurringEventId) series = o;
      else if (o.scope === "series" && o.eventId === e.id) series = o;
    }
    const hit = inst ?? series;
    return hit ? { score: hit.score, scope: hit.scope ?? "instance" } : null;
  }
  const defaultLocation = (explicit.defaultLocation as string | undefined) || undefined;

  // Filter slots to the requested week
  let slots = schedule.slots.filter((s) => {
    const t = new Date(s.start).getTime();
    return t >= weekStart.getTime() && t < weekEnd.getTime();
  });

  // Apply office-hours transforms so the host's own availability view
  // reflects any office-hours rules (soft-protection override inside window).
  // Confirmed bookings are already present as real calendar events via the
  // Google Calendar sync path, so we pass an empty array here.
  const compiledOH = compileOfficeHoursLinks(structuredRules);
  for (const ohRule of compiledOH) {
    const transformed = applyOfficeHoursWindow({
      rule: ohRule,
      slots,
      confirmedBookings: [],
      timezone: schedule.timezone,
    });
    // applyOfficeHoursWindow drops slots outside the window — merge its
    // overrides back into the full week set so the rest of the day still renders.
    const overrideByKey = new Map(transformed.map((s) => [`${s.start}|${s.end}`, s]));
    slots = slots.map((s) => overrideByKey.get(`${s.start}|${s.end}`) ?? s);
  }

  // Filter events to the requested week (include events that overlap)
  const weekFiltered = schedule.events.filter((e) => {
    const eStart = new Date(e.start).getTime();
    const eEnd = new Date(e.end).getTime();
    return eEnd > weekStart.getTime() && eStart < weekEnd.getTime();
  });
  const events = weekFiltered.map((e) => serializeEvent(e, resolveOverride(e)));

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
    } else {
      // Check for an active location rule that covers this day
      const activeRule = structuredRules
        .filter((r) => r.action === "location" && r.status === "active" && r.locationLabel)
        .filter((r) => !r.effectiveDate || r.effectiveDate <= dayStr)
        .filter((r) => !r.expiryDate || r.expiryDate >= dayStr)
        .sort((a, b) => b.priority - a.priority)[0];
      if (activeRule?.locationLabel) {
        locationByDay[dayStr] = activeRule.locationLabel;
      } else if (defaultLocation) {
        locationByDay[dayStr] = defaultLocation;
      } else {
        locationByDay[dayStr] = null;
      }
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

function serializeEvent(
  e: CalendarEvent,
  override: { score: number; scope: "instance" | "series" } | null
) {
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
    recurringEventId: e.recurringEventId,
    isTransparent: e.isTransparent,
    eventType: e.eventType,
    htmlLink: e.htmlLink,
    attendeeRollup: e.attendeeRollup,
    /** Host-set protection override score (0=Open, 3=Protected, 5=Blocked). Undefined if Auto. */
    protectionOverride: override?.score,
    protectionOverrideScope: override?.scope,
  };
}
