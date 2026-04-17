import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { applyEventOverrides, type LinkRules, type ScoredSlot } from "@/lib/scoring";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUserTimezone } from "@/lib/timezone";
import { getActiveLocationRule, compileOfficeHoursLinks, type AvailabilityRule } from "@/lib/availability-rules";
import { applyOfficeHoursWindow, type ConfirmedBooking } from "@/lib/office-hours";
import {
  computeBilateralAvailability,
  type BilateralSlot,
} from "@/lib/bilateral-availability";

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
  // guestId is set only when the session has a logged-in guest (bilateral path).
  // Anonymous guests stay null → bilateral compute is skipped and the response
  // falls back to today's host-only shape.
  let guestId: string | null = null;

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
        guestId: true,
        host: { select: { preferences: true } },
        link: { select: { rules: true, sourceRuleId: true } },
      },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    hostId = session.hostId;
    guestId = session.guestId;
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
    Array<{ start: string; end: string; score: number; isShortSlot?: boolean; isStretch?: boolean }>
  > = {};

  let currentLocation: { label: string; until?: string } | null = null;
  // Bilateral chips (green/orange) grouped by day-key (same format as slotsByDay).
  // Populated only when the session has a logged-in guest with a connected
  // calendar. Undefined in the response when there is no bilateral signal —
  // client falls back to the existing host-only widget.
  let bilateralByDay: Record<string, BilateralSlot[]> | undefined;

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

    const isVip = !selfMode && !!(linkRules as Record<string, unknown>).isVip;

    // Score filter FIRST — so the duration chain-check below only considers
    // slots that would actually be offered to the guest. Without this ordering,
    // filterByDuration builds its consecutive-slot set from ALL slots (including
    // blocked/off-hours ones with score > 1), producing false valid windows like
    // "3:30 PM for a 3-hour meeting" when the subsequent slots are blocked.
    if (!selfMode) {
      const hasExclusive = slots.some((s) => s.score === -2);
      if (hasExclusive) {
        slots = slots.filter((s) => s.score <= -1);
      } else if (isVip) {
        slots = slots.filter((s) => s.score <= 3);
      } else {
        slots = slots.filter((s) => s.score <= 1);
      }
    }

    // Filter out past slots — the calendar cache starts 7 days in the past
    // (for incremental sync coverage) so without this filter the widget would
    // show green chips for times that have already passed.
    const now = new Date();
    slots = slots.filter((s) => new Date(s.start) > now);

    // guestPicks.window clamp (2026-04-17): when the host said "afternoon"
    // etc., the link-rule window is a hard floor on offerable hours. Evaluate
    // in the HOST's timezone so "afternoon" means what the host meant — not
    // what the guest's TZ converts it to.
    if (!selfMode) {
      const guestPicks = (linkRules as Record<string, unknown>).guestPicks as
        | { window?: { startHour?: number; endHour?: number } }
        | undefined;
      const win = guestPicks?.window;
      if (
        win &&
        typeof win.startHour === "number" &&
        typeof win.endHour === "number" &&
        win.endHour > win.startHour
      ) {
        const { slotStartInWindow } = await import("@/lib/time-of-day");
        const clampWindow = { startHour: win.startHour, endHour: win.endHour };
        slots = slots.filter((s) => slotStartInWindow(s.start, clampWindow, timezone));
      }
    }

    // Duration filtering AFTER score filter. Now the consecutive-slot chain
    // only walks through offerable slots — a 3:30 PM start for a 3-hour meeting
    // is correctly rejected if 4:00–6:00 PM slots aren't also offered.
    if (!selfMode) {
      const duration = (linkRules as Record<string, unknown>).duration as number | undefined;
      const minDuration = (linkRules as Record<string, unknown>).minDuration as number | undefined;
      if (duration && duration > 30) {
        const { filterByDuration } = await import("@/lib/scoring");
        slots = filterByDuration(slots, duration, minDuration);
      }
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
        // Score 2-3 on VIP links are stretch slots — shown orange in the widget.
        isStretch: isVip && (slot.score ?? 0) >= 2,
      });
    }

    // ── Bilateral compute. Two paths lead here:
    //
    //   (1) Logged-in guest with their own Google Calendar connected → read
    //       their scored schedule via getOrComputeSchedule(guestId).
    //   (2) Anonymous guest who OAuth'd a read-only calendar connect from
    //       the deal room (Slice 8) → the callback stashed a ScoredSlot[]
    //       snapshot on a system message's metadata. Use that.
    //
    // If neither path yields data, bilateralByDay stays undefined and the
    // widget falls back to host-only rendering (today's behavior).
    if (!selfMode) {
      let guestSlots: ScoredSlot[] = [];
      let guestAvailable = false;

      // Path 1: logged-in guest (live calendar).
      if (guestId && guestId !== hostId) {
        try {
          const guestSchedule = await getOrComputeSchedule(guestId);
          if (guestSchedule.connected) {
            guestSlots = guestSchedule.slots;
            guestAvailable = true;
          }
        } catch (e) {
          console.log("Bilateral compute: guestId lookup failed", guestId, e);
        }
      }

      // Path 2: anonymous-guest calendar snapshot on this session. Only
      // consult if Path 1 didn't produce data — a logged-in guest's live
      // calendar always trumps an older one-time snapshot.
      if (!guestAvailable && sessionId) {
        try {
          const snapshotMsg = await prisma.message.findFirst({
            where: {
              sessionId,
              role: "system",
              metadata: { path: ["kind"], equals: "guest_calendar_snapshot" },
            },
            orderBy: { createdAt: "desc" },
            select: { metadata: true },
          });
          const snapshot = snapshotMsg?.metadata as Record<string, unknown> | null | undefined;
          const snapSlots = snapshot?.scoredSlots;
          if (Array.isArray(snapSlots) && snapSlots.length > 0) {
            guestSlots = snapSlots as ScoredSlot[];
            guestAvailable = true;
          }
        } catch (e) {
          console.log("Bilateral compute: snapshot lookup failed", sessionId, e);
        }
      }

      if (guestAvailable) {
        try {
          const bilateralSlots = computeBilateralAvailability({
            hostSlots: slots,
            guestSlots,
            guestScheduleAvailable: true,
          });
          if (bilateralSlots.length > 0) {
            const grouped: Record<string, BilateralSlot[]> = {};
            for (const bs of bilateralSlots) {
              const dateKey = dateFmt.format(new Date(bs.start));
              if (!grouped[dateKey]) grouped[dateKey] = [];
              grouped[dateKey].push(bs);
            }
            bilateralByDay = grouped;
          }
        } catch (e) {
          console.log("Bilateral compute failed", e);
        }
      }
    }
  } catch (e) {
    console.log("Slots endpoint error:", e);
  }

  const isVipLink = !selfMode && !!(linkRules as Record<string, unknown>).isVip;
  // Pass duration metadata to widget so it can render short-slot tooltips
  const duration = (!selfMode && (linkRules as Record<string, unknown>).duration as number | undefined) || undefined;
  const minDuration = (!selfMode && (linkRules as Record<string, unknown>).minDuration as number | undefined) || undefined;

  return NextResponse.json({
    slotsByDay,
    timezone,
    currentLocation,
    duration,
    minDuration,
    isVip: isVipLink || undefined,
    bilateralByDay,
  });
}
