import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { applyEventOverrides, type LinkRules, type ScoredSlot } from "@/lib/scoring";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// GET /api/negotiate/slots?sessionId=xxx  (guest view — by session)
// GET /api/negotiate/slots?self=true      (host view — authenticated user's own availability)
// Returns scored slots grouped by day for the calendar widget
export async function GET(req: NextRequest) {
  const selfMode = req.nextUrl.searchParams.get("self") === "true";
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  let hostId: string;
  let prefs: Record<string, unknown>;
  let linkRules: LinkRules = {};

  if (selfMode) {
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
    const session = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      select: {
        hostId: true,
        host: { select: { preferences: true } },
        link: { select: { rules: true } },
      },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    hostId = session.hostId;
    prefs = (session.host.preferences as Record<string, unknown>) || {};
    linkRules = (session.link?.rules as LinkRules) || {};
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

  let currentLocation: { label: string; until?: string } | null = null;

  try {
    const schedule = await getOrComputeSchedule(hostId);

    // Widget display: combine both signals — neither suppresses the other
    const todayStr = new Date().toISOString().slice(0, 10);
    const rawLocation = explicit?.currentLocation as { label: string; until?: string } | undefined;
    const activePrefLocation = rawLocation && (!rawLocation.until || rawLocation.until >= todayStr) ? rawLocation : null;
    const googleLocation = schedule.hostLocation;

    if (activePrefLocation && googleLocation) {
      const norm = (s: string) => s.trim().toLowerCase();
      if (norm(activePrefLocation.label) === norm(googleLocation)) {
        currentLocation = activePrefLocation; // agree — show once
      } else {
        // differ — show both so host sees the full picture
        currentLocation = { label: `${activePrefLocation.label} (preferences) · ${googleLocation} (calendar)`, until: activePrefLocation.until };
      }
    } else {
      currentLocation = activePrefLocation ?? (googleLocation ? { label: googleLocation } : null);
    }

    if (!schedule.connected) {
      return NextResponse.json({ slotsByDay: {}, timezone });
    }

    // Apply event-level overrides from link rules
    let slots: ScoredSlot[] = applyEventOverrides(schedule.slots, linkRules, timezone);

    // For guest view: filter based on mode
    // Exclusive mode (any slot has score -2): only show -2 and -1 slots
    // Normal mode: hide score 3+ (moderate friction and above)
    // Host view (selfMode): show everything
    if (!selfMode) {
      const hasExclusive = slots.some((s) => s.score === -2);
      slots = hasExclusive
        ? slots.filter((s) => s.score <= -1)
        : slots.filter((s) => s.score <= 2);
    }

    // Group by day
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    for (const slot of slots) {
      const dateKey = dateFmt.format(new Date(slot.start));
      if (!slotsByDay[dateKey]) slotsByDay[dateKey] = [];
      slotsByDay[dateKey].push({
        start: slot.start,
        end: slot.end,
        score: slot.score,
      });
    }
  } catch (e) {
    console.log("Slots endpoint error:", e);
  }

  return NextResponse.json({ slotsByDay, timezone, currentLocation });
}
