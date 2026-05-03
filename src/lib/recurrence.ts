/**
 * Recurrence expander for NegotiationLink series.
 *
 * Expands a LinkRecurrence config into concrete UTC occurrence start times.
 * We don't use a full RRULE parser — the product surface is a small set of
 * named patterns (weekly, biweekly, monthly by nth-weekday, daily), which
 * keeps the expander small and testable and avoids a dependency.
 *
 * DST discipline:
 *   - Times are authored as local wall-clock (HH:mm) in a specific IANA
 *     timezone. On DST transitions the wall-clock time is preserved, so a
 *     3 PM America/Los_Angeles occurrence stays at 3 PM local across the
 *     spring-forward and fall-back boundaries (UTC offset shifts by an hour).
 *   - This matches Google Calendar's behavior for recurring events bound to
 *     a TZID, which is what we write to GCal.
 *
 * Month-end / leap:
 *   - monthly_nth_weekday is naturally safe (e.g., 2nd Tuesday exists every
 *     month). We deliberately do not expose "monthly on the Nth day" to avoid
 *     the 31st-of-February footgun.
 */

import { Prisma } from "@prisma/client";

export type RecurrencePattern =
  | "weekly"
  | "biweekly"
  | "monthly_nth_weekday"
  | "daily";

/** 0 = Sunday, 1 = Monday, ..., 6 = Saturday — matches Date.getDay(). */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type EndBy =
  | { count: number }
  | { until: string /* ISO UTC */ };

/**
 * `LinkRecurrence` has two valid states (proposal
 * `2026-05-01_recurring-meeting-rendering-and-shareable-template` §3.5):
 *
 *   - **Pre-anchor-commit** — `anchor.firstDateLocal` and `.timeLocal` are
 *     OMITTED. The host has framed the link as a series ("weekly piano
 *     lessons") but is letting the guest pick the first slot. The composer
 *     emits this shape, the link persists with `recurrence` populated, and
 *     readers (greeting, card, landing page, MCP) treat it as recurring.
 *
 *   - **Post-anchor-commit** — both `firstDateLocal` and `timeLocal` are
 *     filled in from the slot the guest picked. This is the shape
 *     `expandRecurrence` and `toRRule` consume to write the GCal master
 *     event. Confirm pipeline (`confirm-pipeline.ts`) is responsible for
 *     promoting pre-commit → post-commit at anchor time.
 *
 * `parseRecurrence` accepts both shapes. `expandRecurrence` / `toRRule`
 * require the post-commit shape and throw a clear error otherwise.
 *
 * `endBy` is OPTIONAL (proposal `2026-05-03_recurring-and-office-hours-widgets`
 * §3.5 — chat-driven narration reshape). When absent, the series runs forever
 * (capped only by the 730-instance GCal hard limit and our 520-occurrence
 * `MAX_OCCURRENCES` defense). The composer no longer auto-emits an `endBy`
 * default; the host bounds the series explicitly via natural language ("for
 * 12 weeks" / "until June") and `endBy` is silent in narration unless the
 * host asked.
 */
export interface LinkRecurrence {
  /** Schema version for forward-compat. */
  v: "1";
  pattern: RecurrencePattern;
  /** IANA zone the wall-clock times are authored in. */
  timezone: string;
  anchor: {
    /** Local date of first occurrence, YYYY-MM-DD. Required post-commit, OMITTED pre-commit. */
    firstDateLocal?: string;
    /** Wall-clock start, "HH:mm" (24h). Required post-commit, OMITTED pre-commit. */
    timeLocal?: string;
    /** Duration in minutes. Always required. */
    durationMin: number;
    /** For monthly_nth_weekday: 1..5 (5 = last). Required when pattern is monthly_nth_weekday. */
    weekOfMonth?: number;
    /** For weekly/biweekly/monthly_nth_weekday: which day. Inferred from firstDateLocal if omitted. */
    dayOfWeek?: DayOfWeek;
  };
  /** End condition. OMIT for forever (silent default per the chat-driven narration model). */
  endBy?: EndBy;
  /** ISO UTC strings — occurrences whose UTC start equals any of these are skipped. */
  exclusions?: string[];
  /** How many days before an occurrence either side can reschedule it. Default 7. */
  rescheduleWindowDays?: number;
}

/** Post-anchor-commit narrowing — `firstDateLocal` and `timeLocal` are present. */
export type CommittedLinkRecurrence = LinkRecurrence & {
  anchor: LinkRecurrence["anchor"] & {
    firstDateLocal: string;
    timeLocal: string;
  };
};

/** True when the recurrence carries a committed anchor (firstDateLocal + timeLocal). */
export function isAnchorCommitted(rec: LinkRecurrence): rec is CommittedLinkRecurrence {
  return typeof rec.anchor.firstDateLocal === "string" && typeof rec.anchor.timeLocal === "string";
}

/**
 * Promote a (possibly pre-commit) recurrence to its committed shape by
 * filling `anchor.firstDateLocal` and `.timeLocal` from the moment `startAt`,
 * interpreted in the host's IANA timezone. Idempotent: existing committed
 * shapes pass through with their original anchor (this matches the
 * confirm-pipeline contract — the slot the guest just picked is the anchor;
 * we don't re-derive on subsequent confirm passes for the same series).
 *
 * Used by `confirm-pipeline.ts` at anchor commit (proposal §5.9).
 */
export function commitAnchorAt(
  rec: LinkRecurrence,
  startAt: Date,
  hostTimezone: string,
): CommittedLinkRecurrence {
  if (isAnchorCommitted(rec)) return rec;
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: hostTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: hostTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return {
    ...rec,
    anchor: {
      ...rec.anchor,
      firstDateLocal: dateFmt.format(startAt),
      timeLocal: timeFmt.format(startAt).replace(/^24:/, "00:"),
    },
  };
}

export interface ExpandedOccurrence {
  /** UTC start instant. */
  startAt: Date;
  /** UTC end instant (startAt + durationMin). */
  endAt: Date;
}

// ─── utilities ──────────────────────────────────────────────────────────

/**
 * Return the UTC Date that represents `YYYY-MM-DD HH:mm` as wall-clock time
 * in the given IANA zone. Uses a one-iteration offset correction — good for
 * any zone whose DST transitions happen at standard times (all of them).
 */
export function localWallToUTC(
  dateLocal: string,
  timeLocal: string,
  tz: string,
): Date {
  const [y, mo, d] = dateLocal.split("-").map(Number);
  const [h, mi] = timeLocal.split(":").map(Number);
  // First guess: pretend local = UTC, then read how the zone actually
  // interprets that instant and correct.
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const offsetMin = getZoneOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offsetMin * 60_000);
}

/** Minutes east of UTC for a given instant in a given zone (e.g. -420 for PDT). */
function getZoneOffsetMinutes(instant: Date, tz: string): number {
  // Format the instant in the target zone and re-parse into a UTC timestamp.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const pick = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // Intl emits "24" for midnight in some locales; normalize.
  const hour = pick("hour") === 24 ? 0 : pick("hour");
  const localAsUTC = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    hour,
    pick("minute"),
    pick("second"),
  );
  return Math.round((localAsUTC - instant.getTime()) / 60_000);
}

/** DayOfWeek (0=Sun..6=Sat) of a YYYY-MM-DD date, interpreted as noon in tz to dodge DST edges. */
function dayOfWeekLocal(dateLocal: string, tz: string): DayOfWeek {
  const [y, mo, d] = dateLocal.split("-").map(Number);
  // Use noon — far from DST transition instants.
  const utc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const offsetMin = getZoneOffsetMinutes(utc, tz);
  const local = new Date(utc.getTime() + offsetMin * 60_000);
  return local.getUTCDay() as DayOfWeek;
}

/** Add `days` calendar days to YYYY-MM-DD in local time, returning YYYY-MM-DD. */
function addDaysLocal(dateLocal: string, days: number): string {
  const [y, mo, d] = dateLocal.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Return the YYYY-MM-DD of the Nth `dow` weekday of month `year-month`. 5 = last. */
function nthWeekdayOfMonth(
  year: number,
  month1to12: number,
  dow: DayOfWeek,
  n: number,
): string | null {
  // First of the month
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstDow = first.getUTCDay();
  const offset = (dow - firstDow + 7) % 7;
  let day = 1 + offset + (n - 1) * 7;
  if (n === 5) {
    // "last" — find the last instance ≤ end-of-month.
    const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
    day = 1 + offset;
    while (day + 7 <= lastDay) day += 7;
  }
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  if (day > lastDay) return null;
  const mm = String(month1to12).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// ─── expander ────────────────────────────────────────────────────────────

/**
 * Max cap on expansion to defend against malformed configs (e.g. until-date
 * far in the future combined with daily pattern).
 */
const MAX_OCCURRENCES = 520; // 10y weekly

/**
 * Expand the recurrence into occurrences whose start falls within [from, to],
 * honoring the endBy cap. Both `from` and `to` are UTC instants. Exclusions
 * are applied.
 */
export function expandRecurrence(
  recIn: LinkRecurrence,
  from: Date,
  to: Date,
): ExpandedOccurrence[] {
  if (recIn.v !== "1") throw new Error(`unsupported recurrence version: ${recIn.v}`);
  if (!isAnchorCommitted(recIn)) {
    throw new Error(
      "expandRecurrence: anchor.firstDateLocal and .timeLocal are required (anchor not yet committed)",
    );
  }
  if (to < from) return [];
  const rec: CommittedLinkRecurrence = recIn;

  const tz = rec.timezone;
  const duration = rec.anchor.durationMin;
  const excl = new Set((rec.exclusions ?? []).map((s) => new Date(s).getTime()));
  // Absent endBy → run forever, capped by MAX_OCCURRENCES (silent default per
  // the chat-driven narration model). Per RFC5545 the absence of UNTIL/COUNT
  // means an unbounded series; we apply our own MAX_OCCURRENCES guard rather
  // than letting GCal's 730 limit be the only ceiling.
  const endBy = rec.endBy;
  const untilMs = endBy && "until" in endBy ? new Date(endBy.until).getTime() : Infinity;
  const countCap = endBy && "count" in endBy ? endBy.count : MAX_OCCURRENCES;
  const isCountBounded = !!endBy && "count" in endBy;

  const dow =
    rec.anchor.dayOfWeek ?? dayOfWeekLocal(rec.anchor.firstDateLocal, tz);

  const out: ExpandedOccurrence[] = [];
  let emitted = 0;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const pushIfInRange = (startAt: Date) => {
    if (startAt.getTime() > untilMs) return false;
    if (excl.has(startAt.getTime())) return true; // counts against countCap per GCal convention? No — skip silently, don't consume.
    if (startAt >= from && startAt <= to) {
      const endAt = new Date(startAt.getTime() + duration * 60_000);
      out.push({ startAt, endAt });
    }
    return true;
  };

  if (rec.pattern === "weekly" || rec.pattern === "biweekly") {
    const stride = rec.pattern === "biweekly" ? 14 : 7;
    let cursor = rec.anchor.firstDateLocal;
    while (emitted < countCap && emitted < MAX_OCCURRENCES) {
      const startAt = localWallToUTC(cursor, rec.anchor.timeLocal, tz);
      if (startAt.getTime() > untilMs) break;
      if (!excl.has(startAt.getTime()) && startAt >= from && startAt <= to) {
        out.push({
          startAt,
          endAt: new Date(startAt.getTime() + duration * 60_000),
        });
      }
      // RFC5545 COUNT includes exclusions — consume regardless.
      emitted++;
      if (startAt > to && !isCountBounded) break;
      cursor = addDaysLocal(cursor, stride);
    }
    return out;
  }

  if (rec.pattern === "daily") {
    let cursor = rec.anchor.firstDateLocal;
    while (emitted < countCap && emitted < MAX_OCCURRENCES) {
      const startAt = localWallToUTC(cursor, rec.anchor.timeLocal, tz);
      if (startAt.getTime() > untilMs) break;
      if (!excl.has(startAt.getTime()) && startAt >= from && startAt <= to) {
        out.push({
          startAt,
          endAt: new Date(startAt.getTime() + duration * 60_000),
        });
      }
      emitted++;
      if (startAt > to && !isCountBounded) break;
      cursor = addDaysLocal(cursor, 1);
    }
    return out;
  }

  if (rec.pattern === "monthly_nth_weekday") {
    const n = rec.anchor.weekOfMonth ?? 1;
    const [y0, m0] = rec.anchor.firstDateLocal.split("-").map(Number);
    let year = y0;
    let month = m0;
    while (emitted < countCap && emitted < MAX_OCCURRENCES) {
      const dateLocal = nthWeekdayOfMonth(year, month, dow, n);
      if (!dateLocal) {
        // "5th weekday" doesn't exist this month — skip without consuming count
        month++;
        if (month > 12) { month = 1; year++; }
        continue;
      }
      const startAt = localWallToUTC(dateLocal, rec.anchor.timeLocal, tz);
      if (startAt.getTime() > untilMs) break;
      if (!excl.has(startAt.getTime()) && startAt >= from && startAt <= to) {
        out.push({
          startAt,
          endAt: new Date(startAt.getTime() + duration * 60_000),
        });
      }
      emitted++;
      if (startAt > to && !isCountBounded) break;
      month++;
      if (month > 12) { month = 1; year++; }
    }
    return out;
  }

  // Keep TS exhaustive; unknown pattern = empty.
  return out;
}

/**
 * Derive the RRULE string we'll write on the GCal master event.
 * GCal accepts RFC5545 RRULE:... content; BYDAY uses 2-letter day codes.
 */
export function toRRule(recIn: LinkRecurrence): string {
  if (!isAnchorCommitted(recIn)) {
    throw new Error(
      "toRRule: anchor.firstDateLocal and .timeLocal are required (anchor not yet committed)",
    );
  }
  const rec: CommittedLinkRecurrence = recIn;
  const dow =
    rec.anchor.dayOfWeek ?? dayOfWeekLocal(rec.anchor.firstDateLocal, rec.timezone);
  const byday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dow];
  const parts: string[] = [];
  if (rec.pattern === "weekly") parts.push("FREQ=WEEKLY", `BYDAY=${byday}`);
  else if (rec.pattern === "biweekly") parts.push("FREQ=WEEKLY", "INTERVAL=2", `BYDAY=${byday}`);
  else if (rec.pattern === "daily") parts.push("FREQ=DAILY");
  else if (rec.pattern === "monthly_nth_weekday") {
    const n = rec.anchor.weekOfMonth ?? 1;
    const nCode = n === 5 ? -1 : n; // "last" → -1 per RFC5545
    parts.push("FREQ=MONTHLY", `BYDAY=${nCode}${byday}`);
  }
  // Absent endBy → emit RRULE without COUNT/UNTIL (open-ended). GCal accepts
  // open-ended RRULEs and silently caps at 730 instances per Google's hard
  // limit; that's the intended "forever" behavior for the chat-driven model.
  if (rec.endBy) {
    if ("count" in rec.endBy) parts.push(`COUNT=${rec.endBy.count}`);
    else {
      const untilUTC = new Date(rec.endBy.until)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
      parts.push(`UNTIL=${untilUTC}`);
    }
  }
  return `RRULE:${parts.join(";")}`;
}

/**
 * Zod-lite runtime check. Returns the value typed, or throws.
 *
 * Accepts both pre-anchor-commit and post-commit shapes (see `LinkRecurrence`
 * doc). `anchor.durationMin` is the only always-required anchor field;
 * `firstDateLocal` and `timeLocal` may be absent on a freshly-created
 * recurring link that defers anchor selection to the guest.
 *
 * `endBy` is OPTIONAL — when absent, the series runs forever (capped only
 * by `MAX_OCCURRENCES` defense + GCal's 730-instance hard limit). The
 * composer no longer auto-emits an `endBy` default; the host bounds the
 * series explicitly via natural language. When present it must be a
 * well-formed `{ count }` or `{ until }` shape.
 */
export function parseRecurrence(raw: unknown): LinkRecurrence {
  if (!raw || typeof raw !== "object") throw new Error("recurrence: not an object");
  const r = raw as Record<string, unknown>;
  if (r.v !== "1") throw new Error(`recurrence: unsupported v=${String(r.v)}`);
  const patterns: RecurrencePattern[] = ["weekly", "biweekly", "monthly_nth_weekday", "daily"];
  if (!patterns.includes(r.pattern as RecurrencePattern)) {
    throw new Error(`recurrence: bad pattern ${String(r.pattern)}`);
  }
  if (typeof r.timezone !== "string") throw new Error("recurrence: timezone");
  const a = r.anchor as Record<string, unknown> | undefined;
  if (!a || typeof a.durationMin !== "number") {
    throw new Error("recurrence: anchor.durationMin");
  }
  if (a.firstDateLocal !== undefined && typeof a.firstDateLocal !== "string") {
    throw new Error("recurrence: anchor.firstDateLocal");
  }
  if (a.timeLocal !== undefined && typeof a.timeLocal !== "string") {
    throw new Error("recurrence: anchor.timeLocal");
  }
  // endBy is optional. When present, must be a well-formed `{count}` or
  // `{until}` shape; absent means forever (silent default).
  if (r.endBy !== undefined) {
    const endBy = r.endBy as Record<string, unknown> | null;
    if (!endBy || typeof endBy !== "object" || !("count" in endBy || "until" in endBy)) {
      throw new Error("recurrence: endBy must be { count } or { until } when present");
    }
    if ("count" in endBy && typeof endBy.count !== "number") {
      throw new Error("recurrence: endBy.count must be a number");
    }
    if ("until" in endBy && typeof endBy.until !== "string") {
      throw new Error("recurrence: endBy.until must be a string");
    }
  }
  return r as unknown as LinkRecurrence;
}

/** Narrow Prisma's JsonValue to LinkRecurrence or null. */
export function readRecurrence(raw: Prisma.JsonValue | null | undefined): LinkRecurrence | null {
  if (raw == null) return null;
  try {
    return parseRecurrence(raw);
  } catch {
    return null;
  }
}
