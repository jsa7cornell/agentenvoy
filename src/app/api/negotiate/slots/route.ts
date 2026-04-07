import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCalendarContext } from "@/lib/calendar";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

interface BlockedWindow {
  start: string; // "08:00"
  end: string; // "10:00"
  days?: string[]; // ["Mon","Tue","Wed","Thu","Fri"]
  label?: string;
  expires?: string; // "2026-04-15"
}

// GET /api/negotiate/slots?sessionId=xxx  (guest view — by session)
// GET /api/negotiate/slots?self=true      (host view — authenticated user's own availability)
// Returns available slots grouped by day for the calendar widget
export async function GET(req: NextRequest) {
  const selfMode = req.nextUrl.searchParams.get("self") === "true";
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  let hostId: string;
  let prefs: Record<string, unknown>;

  if (selfMode) {
    // Host viewing their own availability
    const authSession = await getServerSession(authOptions);
    if (!authSession?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = await prisma.user.findUnique({
      where: { id: authSession.user.id },
      select: { id: true, preferences: true },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    hostId = user.id;
    prefs = (user.preferences as Record<string, unknown>) || {};
  } else if (sessionId) {
    // Guest viewing host's availability via session
    const session = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      select: { hostId: true, host: { select: { preferences: true } } },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    hostId = session.hostId;
    prefs = (session.host.preferences as Record<string, unknown>) || {};
  } else {
    return NextResponse.json(
      { error: "Missing sessionId or self param" },
      { status: 400 }
    );
  }

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
    const ctx = await getCalendarContext(hostId, now, twoWeeks, timezone);

    if (!ctx.connected) {
      return NextResponse.json({ slotsByDay: {}, timezone });
    }

    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const getLocalParts = (date: Date) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        minute: "numeric",
        weekday: "short",
        timeZone: timezone,
      }).formatToParts(date);
      const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
      const minute = Number(
        parts.find((p) => p.type === "minute")?.value ?? 0
      );
      const dayName = parts.find((p) => p.type === "weekday")?.value ?? "";
      const isWeekend = dayName === "Sat" || dayName === "Sun";
      return { hour, minute, isWeekend, dayName };
    };

    // Parse blocked windows from preferences
    const todayStr = new Date().toISOString().slice(0, 10);
    const blockedWindows: BlockedWindow[] = (
      (explicit?.blockedWindows as BlockedWindow[]) || []
    ).filter((w) => !w.expires || w.expires >= todayStr);

    // Check if a local time + day falls within a blocked window
    const isInBlockedWindow = (hour: number, minute: number, dayName: string) => {
      const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      return blockedWindows.some((w) => {
        if (w.days && !w.days.includes(dayName)) return false;
        return timeStr >= w.start && timeStr < w.end;
      });
    };

    const blockingEvents = ctx.events.filter(
      (ev) =>
        !ev.isAllDay &&
        ev.responseStatus !== "declined" &&
        !ev.isTransparent
    );

    const declinedEvents = ctx.events.filter(
      (ev) => ev.responseStatus === "declined" && !ev.isAllDay
    );

    const current = new Date(now);
    const { minute: mins } = getLocalParts(current);
    if (mins > 0 && mins < 30) {
      current.setMinutes(current.getMinutes() + (30 - mins), 0, 0);
    } else if (mins > 30) {
      current.setMinutes(current.getMinutes() + (60 - mins), 0, 0);
    } else {
      current.setSeconds(0, 0);
    }

    while (current < twoWeeks) {
      const { hour, minute, isWeekend, dayName } = getLocalParts(current);

      // Skip weekends and outside business hours
      if (isWeekend || hour < 9 || hour >= 18) {
        current.setMinutes(current.getMinutes() + 30);
        continue;
      }

      // Skip blocked windows
      if (isInBlockedWindow(hour, minute, dayName)) {
        current.setMinutes(current.getMinutes() + 30);
        continue;
      }

      const slotEnd = new Date(current.getTime() + 30 * 60 * 1000);

      const isBlocked = blockingEvents.some(
        (ev) => current < ev.end && slotEnd > ev.start
      );

      if (!isBlocked) {
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
