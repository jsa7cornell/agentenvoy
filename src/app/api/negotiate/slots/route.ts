import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { applyEventOverrides, type LinkRules, type ScoredSlot } from "@/lib/scoring";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUserTimezone } from "@/lib/timezone";
import { getActiveLocationRule, compileOfficeHoursLinks, type AvailabilityRule } from "@/lib/availability-rules";
import { applyOfficeHoursWindow, type ConfirmedBooking } from "@/lib/office-hours";

// GET /api/negotiate/slots?sessionId=xxx  (guest view — by session)
// GET /api/negotiate/slots?self=true      (host view — authenticated user's own availability)
// Returns scored slots grouped by day for the calendar widget
export async function GET(req: NextRequest) {
  const selfMode = req.nextUrl.searchParams.get("self") === "true";
  const sessionId = req.nextUrl.searchParams.get("sessionId");

  let hostId: string;
  let prefs: Record<string, unknown>;
  let linkRules: LinkRules = {};
  let sourceRuleId: string | null = null;

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
        link: { select: { rules: true, sourceRuleId: true } },
      },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    hostId = session.hostId;
    prefs = (session.host.preferences as Record<string, unknown>) || {};
    linkRules = (session.link?.rules as LinkRules) || {};
    sourceRuleId = session.link?.sourceRuleId ?? null;
  } else {
    return NextResponse.json(
      { error: "Missing sessionId or self param" },
      { status: 400 }
    );
  }

  const explicit = prefs.explicit as Record<string, unknown> | undefined;
  const timezone = getUserTimezone(prefs);

  const slotsByDay: Record<
    string,
    Array<{ start: string; end: string; score: number; isShortSlot?: boolean }>
  > = {};

  let currentLocation: { label: string; until?: string } | null = null;

  try {
    const schedule = await getOrComputeSchedule(hostId);

    // Widget display: combine both signals — active location rule + Google workingLocation.
    // The host's private defaultLocation is NEVER surfaced here (guest-facing widget).
    const activeLocRule = getActiveLocationRule((explicit?.structuredRules as AvailabilityRule[] | undefined) ?? []);
    const activePrefLocation = activeLocRule?.locationLabel
      ? { label: activeLocRule.locationLabel, until: activeLocRule.expiryDate }
      : null;
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

    // Office-hours transform: if this session was spawned from an office_hours
    // rule, filter slots through the rule's window + days, override soft
    // protection, and subtract already-booked sibling sessions for the same rule.
    if (sourceRuleId) {
      const allRules = (explicit?.structuredRules as AvailabilityRule[] | undefined) ?? [];
      const compiledLinks = compileOfficeHoursLinks(allRules);
      const compiled = compiledLinks.find((l) => l.ruleId === sourceRuleId);
      if (compiled) {
        // Sibling confirmed bookings — any other session spawned from the same
        // rule that has a confirmed agreedTime. These are the slots guest A already
        // locked in that guest B should see disappear.
        const siblings = await prisma.negotiationSession.findMany({
          where: {
            status: "agreed",
            agreedTime: { not: null },
            link: { sourceRuleId: sourceRuleId },
            ...(sessionId ? { id: { not: sessionId } } : {}),
          },
          select: { agreedTime: true, duration: true },
        });
        const confirmedBookings: ConfirmedBooking[] = siblings
          .filter((s) => s.agreedTime)
          .map((s) => {
            const start = s.agreedTime!;
            const durationMin = s.duration || compiled.durationMinutes;
            return {
              start: start.toISOString(),
              end: new Date(start.getTime() + durationMin * 60 * 1000).toISOString(),
            };
          });
        slots = applyOfficeHoursWindow({
          rule: compiled,
          slots,
          timezone,
          confirmedBookings,
        });
      }
    }

    // Apply duration filtering for guest view. Uses minDuration as the floor
    // when set (host agreed shorter is OK) — lone 30-min slots that satisfy
    // minDuration get isShortSlot: true so the widget can distinguish them.
    if (!selfMode) {
      const duration = (linkRules as Record<string, unknown>).duration as number | undefined;
      const minDuration = (linkRules as Record<string, unknown>).minDuration as number | undefined;
      if (duration && duration > 30) {
        const { filterByDuration } = await import("@/lib/scoring");
        slots = filterByDuration(slots, duration, minDuration);
      }
    }

    // For guest view: filter based on mode
    // Exclusive mode (any slot has score -2): only show -2 and -1 slots
    // Normal mode: hide score 2+ (soft holds and above) — matches greeting template
    // Host view (selfMode): show everything
    if (!selfMode) {
      const hasExclusive = slots.some((s) => s.score === -2);
      slots = hasExclusive
        ? slots.filter((s) => s.score <= -1)
        : slots.filter((s) => s.score <= 1);
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
        isShortSlot: slot.isShortSlot,
      });
    }
  } catch (e) {
    console.log("Slots endpoint error:", e);
  }

  // Pass duration metadata to widget so it can render short-slot tooltips
  const duration = (!selfMode && (linkRules as Record<string, unknown>).duration as number | undefined) || undefined;
  const minDuration = (!selfMode && (linkRules as Record<string, unknown>).minDuration as number | undefined) || undefined;

  return NextResponse.json({ slotsByDay, timezone, currentLocation, duration, minDuration });
}
