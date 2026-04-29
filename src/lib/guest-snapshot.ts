/**
 * Guest calendar snapshot — privacy-filtering rules for `events.list` output.
 *
 * Background: 2026-04-29 bilateral+picker bundle, PR-A1.
 *
 * The OAuth callback at `auth/guest-calendar/callback/route.ts` upgraded
 * from `freebusy.query()` (start/end only) to `events.list()` (start/end +
 * title + visibility + transparency + status + attendees). The richer
 * payload lets the picker's Detailed tab name conflicts ("Standup" instead
 * of dim grey block), but it also means we now handle event titles —
 * data the freebusy path never touched.
 *
 * The filter rules below are deterministic, per-event, and produce two
 * outputs from one event:
 *   - `busy: { start, end }`  — never includes title; feeds existing
 *                                bilateral compute (intersection logic).
 *   - `event: { start, end, title? }` — title kept only when the event's
 *                                visibility/transparency/source allows it.
 *                                Surfaces in the picker's Detailed render.
 *
 * Privacy posture (load-bearing):
 *   - `visibility === "private"` events occupy a busy slot but never carry
 *     a title in the snapshot. The picker renders these as "Busy".
 *   - `transparency === "transparent"` events DON'T block — the user marked
 *     them as "available" (e.g. focus-time markers). Dropped entirely.
 *   - Cancelled events and declined-attendance events are dropped — the
 *     calendar surfaces them but they don't actually take time.
 *   - All-day OOO events are kept; their title may be useful context
 *     ("Out of office — Conference") but the absence of a title is fine.
 */

/** A renderable event for the picker's Detailed tab. */
export interface GuestSnapshotEvent {
  start: string; // ISO
  end: string;   // ISO
  /** Omitted when `visibility === "private"` or no title was set. */
  title?: string;
}

/** A busy interval for bilateral intersection compute. Never has a title. */
export interface GuestSnapshotBusy {
  start: string;
  end: string;
}

/**
 * Subset of the Google Calendar Events API response we care about. Defined
 * as an interface (not a Google type import) so this lib can be unit-tested
 * without pulling googleapis. Fields are named to match what the Calendar
 * API actually returns.
 */
export interface RawCalendarEvent {
  status?: string | null;
  visibility?: string | null;
  transparency?: string | null;
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  attendees?: Array<{
    self?: boolean | null;
    responseStatus?: string | null;
  }> | null;
}

export interface FilterGuestEventsResult {
  /** Renderable events with optional titles. Only includes events that
   *  actually consume time (transparent / cancelled / declined dropped). */
  events: GuestSnapshotEvent[];
  /** Busy intervals derived from the same filtered set, never with titles.
   *  Bilateral intersection compute reads this. */
  busy: GuestSnapshotBusy[];
}

/**
 * Apply the deterministic filter rules and emit both `events` (with optional
 * titles) and `busy` (intervals only) lists.
 *
 * Pure — no I/O, no external deps. Caller (the OAuth callback) is responsible
 * for fetching and persisting the result.
 */
export function filterGuestEvents(raw: RawCalendarEvent[]): FilterGuestEventsResult {
  const events: GuestSnapshotEvent[] = [];
  const busy: GuestSnapshotBusy[] = [];

  for (const ev of raw) {
    // Drop cancelled events — they appear in events.list under
    // `showDeleted: false` for instance-cancellations of recurring series,
    // but never represent real consumed time.
    if (ev.status === "cancelled") continue;

    // Drop transparent events — the user explicitly marked them as not
    // blocking time (Google's "Free" busy-state). These should not appear
    // in the picker as a conflict at all.
    if (ev.transparency === "transparent") continue;

    // Drop declined invites — even though they sit on the calendar surface,
    // they don't actually take the user's time.
    const selfAttendee = ev.attendees?.find((a) => a.self === true);
    if (selfAttendee?.responseStatus === "declined") continue;

    // Resolve start/end. `dateTime` for time-zoned events; `date` for
    // all-day events (YYYY-MM-DD, exclusive end).
    const startIso = ev.start?.dateTime ?? toAllDayStartIso(ev.start?.date);
    const endIso = ev.end?.dateTime ?? toAllDayEndIso(ev.end?.date);
    if (!startIso || !endIso) continue;

    busy.push({ start: startIso, end: endIso });

    // Title-bearing emit: visibility=private strips the title.
    const renderable: GuestSnapshotEvent = { start: startIso, end: endIso };
    if (ev.visibility !== "private" && typeof ev.summary === "string") {
      const trimmed = ev.summary.trim();
      if (trimmed) renderable.title = trimmed;
    }
    events.push(renderable);
  }

  return { events, busy };
}

/**
 * Convert a Google all-day `date` (YYYY-MM-DD) to an ISO instant in UTC for
 * the given day's start. The Calendar API returns these without a tz; we
 * emit the start instant in UTC and let downstream tz-aware grouping handle
 * day-boundary alignment.
 */
function toAllDayStartIso(date: string | null | undefined): string | null {
  if (!date) return null;
  return `${date}T00:00:00.000Z`;
}

/** All-day `end` from Google is exclusive — the day AFTER the event. We
 *  return that as-is; bilateral intersection treats end as exclusive. */
function toAllDayEndIso(date: string | null | undefined): string | null {
  if (!date) return null;
  return `${date}T00:00:00.000Z`;
}
