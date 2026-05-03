import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { applyEventOverrides, type LinkParameters, type ScoredSlot } from "@/lib/scoring";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUserTimezone } from "@/lib/timezone";
import { getActiveLocationRule, compileBookableLinks, type AvailabilityPreference } from "@/lib/availability-rules";
import { computeDensityHorizon } from "@/lib/availability-density";
import { getSchedulingMode } from "@/lib/scheduling-mode";
import { applyBookableWindow, type ConfirmedBooking } from "@/lib/bookable-links";
import { parseLinkParameters } from "@/lib/link-parameters";
import {
  computeBilateralAvailability,
  type BilateralSlot,
} from "@/lib/bilateral-availability";

// GET /api/negotiate/slots?sessionId=xxx            (guest view — by session)
// GET /api/negotiate/slots?sessionId=xxx&tz=...     (guest view, viewer-tz display)
// GET /api/negotiate/slots?self=true                (host view — authenticated user's own availability)
//
// Returns scored slots grouped by day for the calendar widget.
//
// The `tz` query param is display-only: it changes the day-key grouping (so a
// 9pm PT slot groups under the viewer's calendar day, not the host's) and the
// returned `timezone` field. All scoring/filtering internals stay in HOST tz —
// "afternoon means what the host meant" invariants are preserved. Invalid tz
// strings silently fall back to host tz.
export async function GET(req: NextRequest) {
  const selfMode = req.nextUrl.searchParams.get("self") === "true";
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  const viewerTzParam = req.nextUrl.searchParams.get("tz");

  let hostId: string;
  let prefs: Record<string, unknown>;
  let linkRules: LinkParameters = {};
  let recurringWindowId: string | null = null;
  // Link context for per-link posture scoring (V1.5). Set when the request
  // has a session; null for self-mode (Primary posture).
  let scheduleLink: import("@/lib/links/posture").LinkContext | null = null;
  // guestId is set only when the session has a logged-in guest (bilateral path).
  // Anonymous guests stay null → bilateral compute is skipped and the response
  // falls back to today's host-only shape.
  let guestId: string | null = null;
  let partialSessionId: string | null = null;
  // Guest-locked duration override (lock_session_duration action). When
  // present, supersedes linkRules.duration at filter time AND collapses
  // minDuration (a successful lock means the guest has explicitly chosen
  // a longer block; dangling shorter alternatives would confuse the picker).
  // Reusable-link guest-picks proposal, decided 2026-04-28.
  let negotiatedDuration: number | null = null;

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
        // negotiatedDuration: guest-locked duration override. When set,
        // takes precedence over linkRules.duration at slot-search time
        // and overrides minDuration (the lock collapses the short-window
        // path — see proposal §3.6, decided 2026-04-28).
        negotiatedDuration: true,
        host: { select: { preferences: true } },
        link: { select: { type: true, parameters: true, recurringWindowId: true } },
      },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    hostId = session.hostId;
    guestId = session.guestId;
    prefs = (session.host.preferences as Record<string, unknown>) || {};
    linkRules = parseLinkParameters(session.link?.parameters);
    recurringWindowId = session.link?.recurringWindowId ?? null;
    scheduleLink = session.link ? { type: session.link.type ?? undefined, parameters: session.link.parameters } : null;
    partialSessionId = sessionId;
    negotiatedDuration = session.negotiatedDuration ?? null;
  } else {
    return NextResponse.json(
      { error: "Missing sessionId or self param" },
      { status: 400 }
    );
  }

  const explicit = prefs.explicit as Record<string, unknown> | undefined;
  const hostTimezone = getUserTimezone(prefs);

  // Validate viewer tz param — fall back to host tz on any error. Using tz
  // only for display grouping and the returned `timezone` field; all scoring
  // math stays host-tz regardless (see file header).
  let displayTimezone = hostTimezone;
  if (viewerTzParam && !selfMode) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: viewerTzParam }).format(new Date());
      displayTimezone = viewerTzParam;
    } catch {
      // invalid IANA — keep host tz
    }
  }
  // `timezone` alias retained for downstream logic that passes it to scoring
  // and rule-clamp helpers. All such use sites expect HOST tz semantics.
  const timezone = hostTimezone;

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
  // PR-A1 of the bilateral+picker bundle: the canonical payload that the
  // picker's Detailed tab will hydrate from. Both tabs (Best matches + Detailed)
  // now read from the same source of truth — see `computeBilateralForSession`
  // in `bilateral-availability.ts`. The legacy `bilateralByDay` shape is
  // derived from this payload below for backward-compat with today's render.
  let bilateralPayload: Awaited<
    ReturnType<typeof import("@/lib/bilateral-availability").computeBilateralForSession>
  > | undefined;
  // WISHLIST §1o PR-α: when the compute pipeline throws, the catch sets this
  // flag so the response shape becomes `{ slotsByDay: null, error:
  // "compute_failed", ... }` instead of the previous silent fall-through to
  // `slotsByDay: {}` (which was indistinguishable on the wire from a clean
  // run with zero offerable slots). The client routes on this for the
  // "couldn't load times — refresh" affordance.
  let computeFailed = false;

  try {
    const schedule = await getOrComputeSchedule(hostId, { link: scheduleLink });

    // Widget display: combine both signals — active location rule + Google workingLocation.
    // The host's private defaultLocation is NEVER surfaced here (guest-facing widget).
    const activeLocRule = getActiveLocationRule((explicit?.structuredRules as AvailabilityPreference[] | undefined) ?? []);
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
      // Status disambiguation (WISHLIST §1o PR-α): explicit
      // `calendar_disconnected` lets the client render a "host needs to
      // reconnect" inline message instead of falling through to the empty-
      // state path that previously also matched a swallowed exception.
      return NextResponse.json({
        slotsByDay: {},
        timezone: displayTimezone,
        status: "calendar_disconnected",
      });
    }

    // Apply event-level overrides from link rules
    let slots: ScoredSlot[] = applyEventOverrides(schedule.slots, linkRules, timezone);

    // Bookable-link transform: if this session was spawned from a bookable
    // rule, filter slots through the rule's window + days, override soft
    // protection, and subtract already-booked sibling sessions for the same rule.
    if (recurringWindowId) {
      const allRules = (explicit?.structuredRules as AvailabilityPreference[] | undefined) ?? [];
      const compiledLinks = compileBookableLinks(allRules);
      const compiled = compiledLinks.find((l) => l.ruleId === recurringWindowId);
      if (compiled) {
        // Sibling confirmed bookings — any other session spawned from the same
        // rule that has a confirmed agreedTime. These are the slots guest A already
        // locked in that guest B should see disappear.
        const siblings = await prisma.negotiationSession.findMany({
          where: {
            status: "agreed",
            agreedTime: { not: null },
            link: { recurringWindowId: recurringWindowId },
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
        slots = applyBookableWindow({
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

    // Density-aware horizon — skip for self-mode and date-mode links.
    if (!selfMode) {
      const schedulingMode = getSchedulingMode(linkRules as { duration?: number | null });
      if (schedulingMode === "time") {
        const horizonDays = computeDensityHorizon(slots);
        const cutoff = new Date(Date.now() + horizonDays * 86_400_000);
        slots = slots.filter((s) => new Date(s.start) < cutoff);
      }
    }

    const slotSchedulingMode = !selfMode
      ? getSchedulingMode(linkRules as { duration?: number | null })
      : "time";

    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: displayTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    if (slotSchedulingMode === "date") {
      // Date-mode: one entry per viable day (any score ≤ 1 slot present).
      // Duration filtering skipped — consecutive 30-min slots don't apply.
      const viableDays = new Set<string>();
      for (const slot of slots) {
        if ((slot.score ?? 0) > 1) continue;
        viableDays.add(dateFmt.format(new Date(slot.start)));
      }
      Array.from(viableDays).forEach((day) => {
        slotsByDay[day] = [{ start: `${day}T00:00:00.000Z`, end: `${day}T00:00:00.000Z`, score: 0 }];
      });
    } else {
      // Duration filtering AFTER score filter. Now the consecutive-slot chain
      // only walks through offerable slots — a 3:30 PM start for a 3-hour meeting
      // is correctly rejected if 4:00–6:00 PM slots aren't also offered.
      if (!selfMode) {
        const linkDuration = (linkRules as Record<string, unknown>).duration as number | undefined;
        // Guest's lock_session_duration overrides linkRules.duration.
        // When negotiatedDuration is set, both `duration` AND `minDuration`
        // collapse to the negotiated value — the guest has chosen a longer
        // block, so dangling short-window slots that fit only the original
        // minDuration would mislead the picker.
        const duration = negotiatedDuration ?? linkDuration;
        const minDuration = negotiatedDuration ?? ((linkRules as Record<string, unknown>).minDuration as number | undefined);
        if (duration && duration > 30) {
          const { filterByDuration } = await import("@/lib/scoring");
          slots = filterByDuration(slots, duration, minDuration);
        }
      }

      // Group by day. Uses displayTimezone so a 9pm PT slot groups under the
      // viewer's calendar day when the viewer is in ET, not under the host's.
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
    }

    // ── Bilateral compute (canonical, PR-A1 of bilateral+picker bundle).
    //
    // Two flows merge here:
    //   - Logged-in guest with their own Google Calendar → live `getOrComputeSchedule`.
    //   - Anonymous guest who OAuth'd a read-only connect → snapshot on a
    //     system message's metadata.
    //
    // Both flows now hydrate from the same source: `computeBilateralForSession`
    // in `bilateral-availability.ts`. Fast path for the logged-in guest still
    // uses live schedule via the snapshot-less code path; the snapshot path
    // is automatic when no guest user is set.
    //
    // Render shape: this route still returns `bilateralByDay` (legacy
    // chip-list shape) for backward compat with today's picker. The new
    // `bilateralPayload` is also returned — PR-B2's Detailed tab will
    // consume that directly (matched + looseMutual + conflicts split).
    if (!selfMode && sessionId) {
      try {
        const { computeBilateralForSession } = await import(
          "@/lib/bilateral-availability"
        );
        bilateralPayload = await computeBilateralForSession(sessionId, {
          // Picker's render path — the guest sees the Detailed tab on their
          // own device. Sonnet's tool path passes `false` per Cut 2.
          includeConflicts: true,
          // PERF + CORRECTNESS (Wedge B — proposal 2026-05-02_picker-load-perf):
          // reuse the host schedule already loaded at line 147 with link-scoped
          // posture. Without this, computeBilateralForSession re-runs
          // getOrComputeSchedule(hostId) internally with NO link context
          // (Primary posture) — wrong posture for variance-link sessions (V1.5+)
          // and a redundant load (~5 Prisma reads + 2 JSON deserializations).
          // NB: `hostStableSlots` not `hostSlots` — this file already passes a
          // `hostSlots: slots` (post-filter) to computeBilateralAvailability
          // below; mixing them would violate SCORING.md §4.5.
          hostStableSlots: schedule.slots,
        });

        // Logged-in guest fast path: when a live `getOrComputeSchedule`
        // produces fresher data than the snapshot, prefer it for the legacy
        // `bilateralByDay` derivation. The new `bilateralPayload` reflects
        // the snapshot path; consumers reading the new payload accept that.
        let liveBilateralSlots: BilateralSlot[] | null = null;
        if (guestId && guestId !== hostId) {
          try {
            const guestSchedule = await getOrComputeSchedule(guestId);
            if (guestSchedule.connected) {
              liveBilateralSlots = computeBilateralAvailability({
                hostSlots: slots,
                guestSlots: guestSchedule.slots,
                guestScheduleAvailable: true,
              });
            }
          } catch (e) {
            console.log("Bilateral compute: live guest schedule failed", guestId, e);
          }
        }

        // Derive legacy `bilateralByDay` shape. Prefer live data when present;
        // otherwise reduce the canonical payload's `matched` + `looseMutual`
        // arrays into BilateralSlot[] grouped by day-key.
        if (liveBilateralSlots && liveBilateralSlots.length > 0) {
          const grouped: Record<string, BilateralSlot[]> = {};
          for (const bs of liveBilateralSlots) {
            const dateKey = dateFmt.format(new Date(bs.start));
            if (!grouped[dateKey]) grouped[dateKey] = [];
            grouped[dateKey].push(bs);
          }
          bilateralByDay = grouped;
        } else if (bilateralPayload?.available) {
          const grouped: Record<string, BilateralSlot[]> = {};
          for (const day of bilateralPayload.byDay) {
            const dayKey = dateFmt.format(new Date(`${day.date}T12:00:00.000Z`));
            const bucket: BilateralSlot[] = [];
            for (const m of day.matched) {
              bucket.push({ start: m.start, end: m.end, color: "both" });
            }
            for (const lm of day.looseMutual) {
              bucket.push({ start: lm.start, end: lm.end, color: "one" });
            }
            if (bucket.length > 0) {
              grouped[dayKey] = bucket.sort(
                (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
              );
            }
          }
          if (Object.keys(grouped).length > 0) bilateralByDay = grouped;
        }
      } catch (e) {
        console.log("Bilateral compute failed", e);
      }
    }
  } catch (e) {
    // WISHLIST §1o PR-α: structured error log so production occurrences leave
    // a 24h trail on Vercel (`console.error` surfaces as level: error in the
    // runtime logs filter). Previously this was a `console.log` swallow that
    // produced 200 responses with `slotsByDay: {}` — indistinguishable on the
    // wire from a clean run with zero offerable slots. PR-β will use this
    // captured stack trace to fix the actual root cause.
    const err = e instanceof Error ? e : new Error(String(e));
    console.error("[slots] compute pipeline failed", {
      sessionId,
      hostId,
      selfMode,
      errName: err.name,
      errMessage: err.message,
      stack: err.stack,
    });
    computeFailed = true;
  }

  if (computeFailed) {
    return NextResponse.json({
      slotsByDay: null,
      error: "compute_failed",
      timezone: displayTimezone,
      hostTimezone,
    });
  }

  const isVipLink = !selfMode && !!(linkRules as Record<string, unknown>).isVip;
  // Pass duration metadata to widget so it can render short-slot tooltips.
  // Guest-locked duration (negotiatedDuration) supersedes the link default
  // and collapses minDuration so the widget's short-slot affordances stop
  // appearing post-lock.
  const linkDurationMeta = (!selfMode && (linkRules as Record<string, unknown>).duration as number | undefined) || undefined;
  const duration = negotiatedDuration ?? linkDurationMeta;
  const minDuration = negotiatedDuration
    ? negotiatedDuration
    : ((!selfMode && (linkRules as Record<string, unknown>).minDuration as number | undefined) || undefined);

  // Partial-attendance picker data: invitee list + per-slot RSVPs. Returned
  // only when the link has opted in so legacy single/group widgets stay lean.
  let partialAttendance:
    | {
        mode: "allowed";
        minimumAttendees: number | null;
        invitees: Array<{ id: string; name: string }>;
        rsvps: Array<{ inviteeId: string; slotStart: string; status: string }>;
      }
    | undefined;
  if (
    partialSessionId &&
    (linkRules as Record<string, unknown>).partialAttendance === "allowed"
  ) {
    try {
      const invs = await prisma.sessionInvitee.findMany({
        where: { sessionId: partialSessionId },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      });
      const rsvps = await prisma.inviteeSlotRsvp.findMany({
        where: { sessionId: partialSessionId },
        select: { sessionInviteeId: true, slotStart: true, status: true },
      });
      partialAttendance = {
        mode: "allowed",
        minimumAttendees:
          ((linkRules as Record<string, unknown>).minimumAttendees as number | undefined) ?? null,
        invitees: invs,
        rsvps: rsvps.map((r) => ({
          inviteeId: r.sessionInviteeId,
          slotStart: r.slotStart.toISOString(),
          status: r.status,
        })),
      };
    } catch (e) {
      console.warn("[slots] partial-attendance lookup failed (non-blocking):", e);
    }
  }

  // WISHLIST §1o PR-α: `status: "no_slots"` is set when the pipeline ran
  // cleanly to completion but produced zero offerable slots after filters
  // (real product state — host has nothing to offer in the horizon). The
  // calendar-disconnected and compute-failed paths return early above with
  // their own status/error fields, so reaching here always means a clean run.
  const isEmpty = Object.keys(slotsByDay).length === 0;
  return NextResponse.json({
    slotsByDay,
    partialAttendance,
    // `timezone` is the viewer's display tz (viewerTz when set + valid, else
    // host tz). Widget labels slots using this; internal scoring stays host-tz.
    timezone: displayTimezone,
    hostTimezone,
    currentLocation,
    duration,
    minDuration,
    isVip: isVipLink || undefined,
    bilateralByDay,
    // Canonical bilateral payload (PR-A1). Optional in the response —
    // present only when the session has a guest snapshot. PR-B2's Detailed
    // tab consumes this directly; legacy clients that read `bilateralByDay`
    // continue to work unchanged.
    ...(bilateralPayload?.available ? { bilateralPayload } : {}),
    ...(isEmpty ? { status: "no_slots" as const } : {}),
  });
}
