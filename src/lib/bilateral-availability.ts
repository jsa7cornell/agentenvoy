/**
 * Bilateral availability intersection.
 *
 * Takes two scored schedules (host + guest) and produces a color-tagged array
 * describing how each 30-min slot lines up. The LLM never sees the individual
 * scores — only the resulting color — which preserves privacy (neither side
 * learns the *why* behind a slot's status).
 *
 * Privacy contract:
 *   - Green (`works_for_both`)  = bookable on both sides
 *   - Orange (`works_for_one`)  = bookable on one side, protected/tentative
 *                                  on the other (ambiguous which side).
 *   - Omitted                   = blocked on at least one side, or the host
 *                                  has no offerable window there at all.
 *
 * The "ambiguous which side" property is essential — never expose which party
 * is the blocker. Orange chips imply "there's friction here" without naming it.
 *
 * `conflicts` (added 2026-04-29 bilateral+picker bundle, PR-A1) is a separate
 * axis — it's the GUEST's own busy events, with optional titles where the
 * guest's calendar permitted them. This is guest-self-data, render-layer-only
 * by default. Sonnet's tool path passes `includeConflicts: false` so titles
 * never enter the host-visible deal-room thread (Cut 2 privacy posture). The
 * picker's render path passes `true` because the guest sees the titles on
 * their own device.
 */

import type { ScoredSlot } from "@/lib/scoring";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { hostFirstName as resolveHostFirstName } from "@/lib/host-naming";
import { getUserTimezone } from "@/lib/timezone";

// ─── Public types ────────────────────────────────────────────────────────────

export type BilateralColor = "both" | "one";

export interface BilateralSlot {
  start: string; // ISO
  end: string;   // ISO
  color: BilateralColor;
}

export interface ComputeBilateralInput {
  /** Host's offerable slots (already filtered to score ≤ 1 by caller, or raw). */
  hostSlots: ScoredSlot[];
  /** Guest's scored slots (raw from getOrComputeSchedule). May be empty. */
  guestSlots: ScoredSlot[];
  /**
   * When true, the guest's schedule was not available (no connected calendar
   * or fetch failed). In that case we return [] — no bilateral chips. Never
   * silently assume the guest is "open" when we have no signal.
   */
  guestScheduleAvailable: boolean;
  /** Current time. Slots before now are excluded. Parameterized for testability. */
  now?: Date;
}

// ─── Score buckets (mirrored from src/lib/scoring.ts) ────────────────────────

/** Bookable for the viewer — a slot this party is willing to offer. */
export function isBookable(score: number): boolean {
  return score <= 1;
}

/** Protected — might open up with a push, but not offered by default. */
export function isProtected(score: number): boolean {
  return score === 2 || score === 3;
}

/** Blocked — a hard no. Real event, blackout day, deep off-hours. */
export function isBlocked(score: number): boolean {
  return score >= 4;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute the bilateral color for each 30-min slot in the host's offerable
 * window. Deterministic, pure — ready for unit tests.
 *
 * Returns only slots with color "both" or "one". Slots where either side is
 * blocked, or where the host has no entry at all, are omitted (no empty cells
 * in the output — the chip list is just the actionable set).
 *
 * Results are sorted by start time ascending.
 */
export function computeBilateralAvailability(input: ComputeBilateralInput): BilateralSlot[] {
  const { hostSlots, guestSlots, guestScheduleAvailable } = input;
  const now = input.now ?? new Date();

  // Without guest signal, we cannot compute bilateral. Surface nothing —
  // callers render fall-back UI (e.g. host-only widget) instead.
  if (!guestScheduleAvailable) return [];

  // Index guest slots by start time for O(1) lookup.
  const guestByStart = new Map<string, ScoredSlot>();
  for (const g of guestSlots) {
    guestByStart.set(g.start, g);
  }

  const out: BilateralSlot[] = [];

  for (const host of hostSlots) {
    // Only consider slots in the host's offerable window. Out-of-window is
    // implicitly blocked for the host and produces no bilateral signal.
    if (!isBookable(host.score)) continue;

    // Skip past slots.
    if (new Date(host.start) <= now) continue;

    // Guest slot at the same timestamp — missing means the scoring engine
    // didn't emit one for this time, which we treat as unknown (not emitting
    // a chip, to avoid falsely claiming the guest is open).
    const guest = guestByStart.get(host.start);
    if (!guest) continue;

    // If either side is blocked (score ≥ 4), omit — no chip at all.
    if (isBlocked(guest.score)) continue;

    // Guest bookable + host bookable → GREEN.
    if (isBookable(guest.score)) {
      out.push({ start: host.start, end: host.end, color: "both" });
      continue;
    }

    // Guest protected (2–3) + host bookable → ORANGE.
    if (isProtected(guest.score)) {
      out.push({ start: host.start, end: host.end, color: "one" });
      continue;
    }

    // Unknown score state — be conservative and omit.
  }

  // Sort ascending by start time for stable, chronological rendering.
  out.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return out;
}

// ─── Day grouping helper ─────────────────────────────────────────────────────

export interface BilateralSlotsByDay {
  /** Day label in the given timezone (e.g. "Tue, Apr 21"). */
  day: string;
  slots: BilateralSlot[];
}

/**
 * Group bilateral slots by day in the given timezone for chip-list rendering.
 * Days with no slots are omitted. Preserves original slot order within each day.
 */
export function groupBilateralByDay(
  slots: BilateralSlot[],
  timezone: string,
): BilateralSlotsByDay[] {
  const byDay = new Map<string, BilateralSlot[]>();
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: timezone,
    });

  for (const slot of slots) {
    const day = fmt(slot.start);
    const list = byDay.get(day) ?? [];
    list.push(slot);
    byDay.set(day, list);
  }

  return Array.from(byDay.entries()).map(([day, slotsForDay]) => ({
    day,
    slots: slotsForDay,
  }));
}

// ─── Canonical compute path (PR-A1) ──────────────────────────────────────────
//
// `computeBilateralForSession` is the single source of truth for both
// consumers (Sonnet's `get_matched_availability` tool, and the picker's
// Best-matches + Detailed render). One type, one compute path; drift between
// the two surfaces becomes a TS compile failure rather than a runtime bug.
//
// Defense-in-depth: `includeConflicts: true` is render-layer-only (guest's
// own device). Any caller that persists output to a host-visible thread
// (deal-room messages, greeting prose, dashboard chat, any future chat
// surface) MUST pass `false`. Greeting prose, message handlers, and any chat
// surface count as host-visible.

/**
 * A point-in-time tagged with its host-canonical and (when different) viewer
 * label. Honors the 2026-04-21 dual-tz contract — host-tz is canonical.
 */
export interface BilateralTime {
  /** ISO with offset, viewer-tz canonical for sorting / equality. */
  start: string;
  end: string;
  /** Host-tz rendering, e.g. "9 AM PT". Always present. */
  hostLabel: string;
  /** Viewer-tz rendering, e.g. "12 PM ET". Present iff host-tz !== viewer-tz. */
  viewerLabel?: string;
}

/**
 * A guest's own busy event, surfaced only when `includeConflicts: true`.
 * `title` is omitted for events the guest's calendar marked as private,
 * declined, transparent, or all-day OOO without a descriptive label.
 */
export interface GuestConflict {
  start: string;
  end: string;
  title?: string;
}

/**
 * Per-day rollup of all bilateral primitives the guest's surface needs.
 *
 * - `matched`     — both calendars confirm; tappable as a definitive booking.
 * - `looseMutual` — host-prefers / "schedule juggle" friction. The privacy
 *                   semantic is "ambiguous which side" per the contract above.
 * - `conflicts`   — guest's own events, render-layer-only. Empty when
 *                   `includeConflicts: false`.
 * - `hasHostHours` — true iff the host's offerable schedule covers any of
 *                   this day. Used to render "outside John's working hours"
 *                   for empty days without naming the side that's busy.
 */
export interface DayBilateral {
  /** YYYY-MM-DD in viewer tz. */
  date: string;
  matched: BilateralTime[];
  looseMutual: BilateralTime[];
  conflicts: GuestConflict[];
  hasHostHours: boolean;
}

/**
 * Canonical bilateral payload — the type both consumers (Sonnet tool, picker
 * render) import. Type changes break compile across both: drift becomes a
 * CI failure rather than a runtime divergence.
 */
export interface BilateralPayload {
  /** False when the session has no guest snapshot. Caller falls back to
   *  current host-only behavior. Sonnet's playbook handles this without
   *  surfacing plumbing language to the guest. */
  available: boolean;
  /** Host's first name for prose templating. Always present (resolves to
   *  "Host" when no user record). Single source of truth — same util the
   *  picker render uses, so chat and picker can never say different names. */
  hostFirstName: string;
  /** Concise prose like "Mon-Fri 9am-5pm" for "outside John's working hours"
   *  fallback prose. Optional — derivation is opinionated and can ship in a
   *  follow-up if the v1 placeholder doesn't read well. */
  hostHours?: string;
  byDay: DayBilateral[];
}

export interface ComputeBilateralForSessionOptions {
  /** Window to compute over. Defaults to 14 days from now. */
  dateRange?: { start: string; end: string };
  /**
   * Whether to populate `byDay[].conflicts`. Defaults to `false` — the safe
   * setting for any call site that might persist output to a host-visible
   * thread. Picker's render path passes `true`; Sonnet tool passes `false`.
   */
  includeConflicts?: boolean;
}

const HOST_HOURS_PLACEHOLDER = "flexible";

/**
 * Format a slot's start/end into host-canonical and (when different) viewer
 * labels. Pure — pull this out into a separate helper if other call sites
 * grow.
 */
export function formatBilateralTime(
  startIso: string,
  endIso: string,
  hostTz: string,
  viewerTz?: string,
): BilateralTime {
  const start = new Date(startIso);
  const fmt = (tz: string) => {
    const longTzName = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    })
      .formatToParts(start)
      .find((p) => p.type === "timeZoneName")?.value;
    const time = start.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    });
    return longTzName ? `${time} ${longTzName}` : time;
  };
  const result: BilateralTime = {
    start: startIso,
    end: endIso,
    hostLabel: fmt(hostTz),
  };
  if (viewerTz && viewerTz !== hostTz) {
    result.viewerLabel = fmt(viewerTz);
  }
  return result;
}

interface SnapshotShape {
  kind: "guest_calendar_snapshot";
  // PR-A1 shape.
  busy?: Array<{ start: string; end: string }>;
  events?: GuestConflict[];
  // Legacy field — present on snapshots written before PR-A1, absent after.
  // When present, this code falls back to deriving busy intervals from it
  // for backward compatibility with in-flight sessions. Read-only — no new
  // writer emits this field.
  scoredSlots?: ScoredSlot[];
}

/**
 * Load the most recent `guest_calendar_snapshot` for a session. Returns null
 * if the guest never connected (anonymous link) or if the snapshot can't be
 * parsed.
 */
async function loadGuestSnapshot(sessionId: string): Promise<SnapshotShape | null> {
  try {
    const msg = await prisma.message.findFirst({
      where: {
        sessionId,
        role: "system",
        metadata: { path: ["kind"], equals: "guest_calendar_snapshot" },
      },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });
    if (!msg) return null;
    const meta = msg.metadata as unknown;
    if (typeof meta !== "object" || meta === null) return null;
    return meta as SnapshotShape;
  } catch (e) {
    console.error("[bilateral] snapshot load failed", { sessionId, error: e });
    return null;
  }
}

/**
 * Reconstruct guest scored slots from a snapshot. Prefers the new `busy`
 * shape; falls back to legacy `scoredSlots` for in-flight sessions whose
 * snapshot predates PR-A1.
 *
 * Output: 30-min `score: 1` slots for every non-busy half-hour in the
 * window. Mirrors the legacy callback's emission so bilateral compute
 * sees the same data shape regardless of snapshot vintage.
 */
function snapshotToGuestSlots(
  snapshot: SnapshotShape,
  windowStart: Date,
  windowEnd: Date,
): ScoredSlot[] {
  // Legacy fallback.
  if (snapshot.scoredSlots && Array.isArray(snapshot.scoredSlots)) {
    return snapshot.scoredSlots;
  }
  const busy = snapshot.busy ?? [];
  const busyDates = busy.map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
  const slots: ScoredSlot[] = [];
  const cursor = new Date(windowStart);
  cursor.setMinutes(Math.ceil(cursor.getMinutes() / 30) * 30, 0, 0);
  while (cursor < windowEnd && slots.length < 672) {
    const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
    const isBusy = busyDates.some((b) => cursor < b.end && slotEnd > b.start);
    if (!isBusy) {
      slots.push({
        start: cursor.toISOString(),
        end: slotEnd.toISOString(),
        score: 1,
        kind: "open",
        reason: "guest free (snapshot)",
        confidence: "high",
      } as ScoredSlot);
    }
    cursor.setMinutes(cursor.getMinutes() + 30);
  }
  return slots;
}

/**
 * Walk events from the snapshot and clip them into per-day GuestConflict
 * lists. Events spanning multiple days are split at the day boundary in the
 * caller's tz so each day's `conflicts` are self-contained.
 */
function eventsByDay(
  events: GuestConflict[],
  viewerTz: string,
): Map<string, GuestConflict[]> {
  const out = new Map<string, GuestConflict[]>();
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: viewerTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const ev of events) {
    const dateKey = dateFmt.format(new Date(ev.start));
    const list = out.get(dateKey) ?? [];
    list.push(ev);
    out.set(dateKey, list);
  }
  return out;
}

/**
 * The canonical compute path. Loads the session, joins the host's scored
 * schedule with the guest's snapshot, and emits a `BilateralPayload` ready
 * for either consumer.
 *
 * Returns `{ available: false }` for sessions without a guest snapshot —
 * caller renders the host-only fallback. Never throws on user-facing
 * errors; logs and degrades.
 */
export async function computeBilateralForSession(
  sessionId: string,
  options: ComputeBilateralForSessionOptions = {},
): Promise<BilateralPayload> {
  const includeConflicts = options.includeConflicts ?? false;

  // Load session + host. We need hostId (for scored schedule), the host's
  // user record (for hostFirstName + hostTz), and the viewer tz.
  let session: {
    hostId: string;
    guestTimezone: string | null;
    host: { name: string | null; preferences: unknown };
  } | null = null;
  try {
    session = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      select: {
        hostId: true,
        guestTimezone: true,
        host: {
          select: { name: true, preferences: true },
        },
      },
    });
  } catch (e) {
    console.error("[bilateral] session load failed", { sessionId, error: e });
  }

  if (!session) {
    return {
      available: false,
      hostFirstName: "Host",
      byDay: [],
    };
  }

  const hostFirst = resolveHostFirstName(session.host);

  // Resolve host tz via the canonical primitive. Falls through to default.
  const hostTz = getUserTimezone(
    session.host.preferences as Record<string, unknown> | null,
  );
  const viewerTz = session.guestTimezone ?? hostTz;

  // Load snapshot. Absent → not available.
  const snapshot = await loadGuestSnapshot(sessionId);
  if (!snapshot) {
    return {
      available: false,
      hostFirstName: hostFirst,
      byDay: [],
    };
  }

  // Window. Default 14 days.
  const now = new Date();
  const windowStart = options.dateRange
    ? new Date(options.dateRange.start)
    : now;
  const windowEnd = options.dateRange
    ? new Date(options.dateRange.end)
    : new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Host scored schedule.
  let hostSlots: ScoredSlot[] = [];
  try {
    const schedule = await getOrComputeSchedule(session.hostId);
    hostSlots = schedule.slots;
  } catch (e) {
    console.error("[bilateral] host schedule load failed", { sessionId, error: e });
  }

  // Guest scored slots from snapshot.
  const guestSlots = snapshotToGuestSlots(snapshot, windowStart, windowEnd);

  // Run the existing bilateral compute. Returns flat color-tagged slot list.
  const colorSlots = computeBilateralAvailability({
    hostSlots,
    guestSlots,
    guestScheduleAvailable: true,
    now,
  });

  // Group by day in viewer tz, splitting matched vs looseMutual.
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: viewerTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayMap = new Map<string, DayBilateral>();
  function ensureDay(dateKey: string): DayBilateral {
    let day = dayMap.get(dateKey);
    if (!day) {
      day = {
        date: dateKey,
        matched: [],
        looseMutual: [],
        conflicts: [],
        hasHostHours: false,
      };
      dayMap.set(dateKey, day);
    }
    return day;
  }

  // Seed `hasHostHours` per day from the host's bookable slots — even days
  // without a matched/looseMutual entry need this so the chat copy can pick
  // "outside John's working hours" vs "no overlap" without naming the side
  // that's busy.
  for (const hs of hostSlots) {
    if (hs.score > 1) continue;
    const dateKey = dateFmt.format(new Date(hs.start));
    ensureDay(dateKey).hasHostHours = true;
  }

  for (const cs of colorSlots) {
    const dateKey = dateFmt.format(new Date(cs.start));
    const day = ensureDay(dateKey);
    const time = formatBilateralTime(
      cs.start,
      cs.end,
      hostTz,
      viewerTz === hostTz ? undefined : viewerTz,
    );
    if (cs.color === "both") {
      day.matched.push(time);
    } else {
      day.looseMutual.push(time);
    }
  }

  if (includeConflicts && snapshot.events && snapshot.events.length > 0) {
    const evByDay = eventsByDay(snapshot.events, viewerTz);
    Array.from(evByDay.entries()).forEach(([dateKey, evs]) => {
      ensureDay(dateKey).conflicts = evs;
    });
  }

  // Return days sorted ascending so consumers don't re-sort.
  const byDay = Array.from(dayMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return {
    available: true,
    hostFirstName: hostFirst,
    hostHours: HOST_HOURS_PLACEHOLDER,
    byDay,
  };
}
