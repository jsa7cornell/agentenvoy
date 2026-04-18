/**
 * Week-anchor helpers — "today / this week / next week" date strings
 * pre-computed in the host's timezone.
 *
 * Why: the LLM inside the deal room gets a DATE REFERENCE list of dates,
 * but has no reliable way to determine which entry is TODAY, or which
 * 7-day span counts as "this week" vs "next week." Every time a host or
 * guest says "next week," the LLM has to compute — and it gets this
 * wrong. We saw this 2026-04-18 when "next week" was interpreted as
 * two weeks out instead of one.
 *
 * Convention (Monday-start week, to match calendar convention + John's
 * spec 2026-04-18):
 *   - "This week" = Monday of the ISO week containing today → Sunday
 *   - "Next week" = Monday of the following ISO week → Sunday
 *   - "Today" = today's date in the host's timezone
 *
 * All outputs are human-readable labels ("Mon, Apr 20, 2026") — the LLM
 * copies them verbatim into the OFFERABLE SLOTS list it picks from. The
 * playbook at `src/agent/playbooks/calendar.md` says LLMs never compute
 * day-of-week; these helpers give them pre-formatted answers.
 *
 * Pure functions; unit-testable without a server.
 */

export interface WeekAnchors {
  /** IANA timezone these anchors were computed in. */
  timezone: string;
  /** "Sat, Apr 18, 2026" — today in the host's tz, same format as DATE REFERENCE entries. */
  today: string;
  /** "Sun" | "Mon" | ... | "Sat" — weekday name for today. */
  todayWeekday: string;
  /** "Mon, Apr 13, 2026" — start of the week containing today (Monday). */
  thisWeekStart: string;
  /** "Sun, Apr 19, 2026" — end of the week containing today. */
  thisWeekEnd: string;
  /** "Mon, Apr 20, 2026" — start of the week AFTER this week. */
  nextWeekStart: string;
  /** "Sun, Apr 26, 2026" — end of the week after this week. */
  nextWeekEnd: string;
  /** True when said mid-week (Mon–Sat) → "next week" is unambiguously the
   *  following Monday. False on Sunday → ambiguity: the user may mean the
   *  very next day OR a week later. Playbook uses this to know when to
   *  confirm. */
  nextWeekUnambiguous: boolean;
}

/**
 * Format a Date to "Weekday, Mon Day, Year" in the given timezone.
 */
function formatDayFull(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  }).format(d);
}

function formatWeekdayShort(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: tz,
  }).format(d);
}

/**
 * Compute "this week" / "next week" anchors for the given moment in the
 * host's timezone. "This week" is Monday → Sunday, anchored on the date
 * that today falls into when viewed in `tz`.
 *
 * Implementation note: we use a day-of-week probe via Intl (not
 * Date#getDay, which reads server-local time) so this works correctly
 * when the server is in UTC but the host is somewhere else.
 */
export function computeWeekAnchors(now: Date, tz: string): WeekAnchors {
  // Day-of-week index in the host timezone (0=Sun..6=Sat).
  const weekdayLong = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: tz,
  }).format(now);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const todayDow = DOW.indexOf(weekdayLong); // 0=Sun..6=Sat, -1 if parse failed

  // Monday = 1 (JS convention); shift so Monday of THIS week is days ago.
  // If today is Sunday, Monday-of-this-week is 6 days ago (last Monday).
  const daysSinceMonday = todayDow === 0 ? 6 : todayDow - 1;

  // Extract the host-local calendar date (NOT server-UTC date — those can
  // differ by a day when the host is west of UTC late at night). We anchor
  // arithmetic on UTC noon of that host-local day to dodge DST rollovers
  // when stepping ±7 days.
  const partsFmt = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  });
  const parts = partsFmt.formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value ?? "1970");
  const m = Number(parts.find((p) => p.type === "month")?.value ?? "1");
  const d = Number(parts.find((p) => p.type === "day")?.value ?? "1");
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const addDays = (base: Date, n: number): Date =>
    new Date(base.getTime() + n * 24 * 60 * 60 * 1000);

  const thisWeekStartDate = addDays(utcNoon, -daysSinceMonday);
  const thisWeekEndDate = addDays(thisWeekStartDate, 6);
  const nextWeekStartDate = addDays(thisWeekStartDate, 7);
  const nextWeekEndDate = addDays(nextWeekStartDate, 6);

  return {
    timezone: tz,
    today: formatDayFull(utcNoon, tz),
    todayWeekday: formatWeekdayShort(utcNoon, tz),
    thisWeekStart: formatDayFull(thisWeekStartDate, tz),
    thisWeekEnd: formatDayFull(thisWeekEndDate, tz),
    nextWeekStart: formatDayFull(nextWeekStartDate, tz),
    nextWeekEnd: formatDayFull(nextWeekEndDate, tz),
    // "Next week" on Sunday is the ambiguity John flagged 2026-04-18:
    // the upcoming Monday could be "tomorrow" or "first day of next week,"
    // and people honestly differ. Ask. Every other weekday is unambiguous.
    nextWeekUnambiguous: todayDow !== 0,
  };
}

/**
 * Format a WeekAnchors block as a string that slots cleanly into the
 * DATE REFERENCE section of the LLM prompt. Kept short — the LLM needs
 * to grep this, not read a paragraph.
 */
export function formatWeekAnchorsForPrompt(a: WeekAnchors): string {
  const lines = [
    `  TODAY: ${a.today}`,
    `  THIS WEEK: ${a.thisWeekStart} – ${a.thisWeekEnd}`,
    `  NEXT WEEK: ${a.nextWeekStart} – ${a.nextWeekEnd}`,
  ];
  if (!a.nextWeekUnambiguous) {
    lines.push(
      `  (Today is ${a.todayWeekday} — "next week" is AMBIGUOUS: user may mean the very next day or a full week later. Confirm with them before acting.)`,
    );
  }
  return lines.join("\n");
}
