import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCalendarContext } from "@/lib/calendar";

// GET /api/negotiate/slots?sessionId=xxx
// Returns host's available slots grouped by day for the calendar widget
// Only returns score 0 (explicitly free) and score 1 (open business hours) slots
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: {
      hostId: true,
      host: { select: { preferences: true } },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const prefs = (session.host.preferences as Record<string, unknown>) || {};
  const explicit = prefs.explicit as Record<string, unknown> | undefined;
  const timezone =
    (explicit?.timezone as string) ||
    (prefs.timezone as string) ||
    "America/Los_Angeles";

  const slotsByDay: Record<
    string,
    Array<{ start: string; end: string; score: number }>
  > = {};

  try {
    const now = new Date();
    const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const ctx = await getCalendarContext(session.hostId, now, twoWeeks, timezone);

    if (!ctx.connected) {
      return NextResponse.json({ slotsByDay: {}, timezone });
    }

    // Date formatter for grouping by day
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    // Compute local day parts for a date
    const getLocalParts = (date: Date) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        minute: "numeric",
        weekday: "short",
        timeZone: timezone,
      }).formatToParts(date);
      const hour = Number(
        parts.find((p) => p.type === "hour")?.value ?? 0
      );
      const minute = Number(
        parts.find((p) => p.type === "minute")?.value ?? 0
      );
      const dayName = parts.find((p) => p.type === "weekday")?.value ?? "";
      const isWeekend = dayName === "Sat" || dayName === "Sun";
      return { hour, minute, isWeekend };
    };

    // Filter to blocking events only (not declined, not transparent)
    const blockingEvents = ctx.events.filter(
      (ev) =>
        !ev.isAllDay &&
        ev.responseStatus !== "declined" &&
        !ev.isTransparent
    );

    // Generate 30-minute slots during business hours (9-18)
    // Score 0 = explicitly free (declined event was here), Score 1 = open business hours
    const current = new Date(now);
    // Snap to next :00 or :30
    const { minute: mins } = getLocalParts(current);
    if (mins > 0 && mins < 30) {
      current.setMinutes(current.getMinutes() + (30 - mins), 0, 0);
    } else if (mins > 30) {
      current.setMinutes(current.getMinutes() + (60 - mins), 0, 0);
    } else {
      current.setSeconds(0, 0);
    }

    // Collect declined events for score-0 detection
    const declinedEvents = ctx.events.filter(
      (ev) => ev.responseStatus === "declined" && !ev.isAllDay
    );

    while (current < twoWeeks) {
      const { hour, isWeekend } = getLocalParts(current);

      // Skip weekends and outside business hours
      if (isWeekend || hour < 9 || hour >= 18) {
        current.setMinutes(current.getMinutes() + 30);
        continue;
      }

      const slotEnd = new Date(current.getTime() + 30 * 60 * 1000);

      // Check if slot overlaps with any blocking event
      const isBlocked = blockingEvents.some(
        (ev) => current < ev.end && slotEnd > ev.start
      );

      if (!isBlocked) {
        // Check if this slot overlaps with a declined event (score 0)
        const isDeclinedSlot = declinedEvents.some(
          (ev) => current < ev.end && slotEnd > ev.start
        );

        const dateKey = dateFmt.format(current);
        if (!slotsByDay[dateKey]) slotsByDay[dateKey] = [];
        slotsByDay[dateKey].push({
          start: new Date(current).toISOString(),
          end: slotEnd.toISOString(),
          score: isDeclinedSlot ? 0 : 1,
        });
      }

      current.setMinutes(current.getMinutes() + 30);
    }
  } catch (e) {
    console.log("Slots endpoint calendar error:", e);
  }

  return NextResponse.json({ slotsByDay, timezone });
}
