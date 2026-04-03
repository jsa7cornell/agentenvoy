import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAvailableSlots } from "@/lib/calendar";

// GET /api/negotiate/slots?sessionId=xxx
// Returns host's available slots grouped by day for the calendar widget
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

  // Determine host timezone from preferences
  const prefs = (session.host.preferences as Record<string, unknown>) || {};
  const explicit = prefs.explicit as Record<string, unknown> | undefined;
  const timezone =
    (explicit?.timezone as string) ||
    (prefs.timezone as string) ||
    "America/New_York";

  const slotsByDay: Record<string, Array<{ start: string; end: string }>> = {};

  try {
    const now = new Date();
    const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const slots = await getAvailableSlots(session.hostId, now, twoWeeks);

    // Group by date in host's timezone
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    for (const slot of slots) {
      const dateKey = fmt.format(slot.start); // YYYY-MM-DD
      if (!slotsByDay[dateKey]) slotsByDay[dateKey] = [];
      slotsByDay[dateKey].push({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      });
    }
  } catch (e) {
    console.log("Slots endpoint calendar error:", e);
    // Return empty — calendar widget shows all gray
  }

  return NextResponse.json({ slotsByDay, timezone });
}
