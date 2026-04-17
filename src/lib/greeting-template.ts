/**
 * Deterministic greeting template helpers.
 *
 * Used by `src/app/api/negotiate/session/route.ts` to build the first message
 * in a 1:1 deal room without calling an LLM. Exported as standalone functions
 * so they can be unit-tested in isolation.
 */

import type { ScoredSlot } from "@/lib/scoring";
import { filterByDuration } from "@/lib/scoring";
import { shortTimezoneLabel } from "./timezone";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FormattedWindows {
  /** One bullet line per day, e.g. "  • Mon Apr 15 — 10–11:30 AM ★, 2–4 PM" */
  lines: string[];
  /** True if any shown block contains a preferred (score ≤ -1) slot. */
  hasPreferred: boolean;
  /** True if any block was truncated by the 3-hour cap or days were capped. */
  wasTruncated: boolean;
}

// ─── Timezone label ──────────────────────────────────────────────────────────

// Re-export the canonical long-label helper so existing call sites don't have
// to change. New code should import `longTimezoneLabel` from "@/lib/timezone".
export { longTimezoneLabel as humanTimezoneLabel } from "./timezone";

// ─── Time formatters ─────────────────────────────────────────────────────────

/** "10 AM", "3:30 PM" — drops :00 for on-the-hour times. */
function fmtTimeShort(d: Date, timezone: string): string {
  const raw = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  return raw.replace(/:00/g, "");
}

/** "10–11 AM" when AM/PM match, otherwise "10 AM–2 PM". */
function fmtTimeRange(start: Date, end: Date, timezone: string): string {
  const s = fmtTimeShort(start, timezone);
  const e = fmtTimeShort(end, timezone);
  const sMatch = s.match(/^(.+)\s(AM|PM)$/);
  const eMatch = e.match(/^(.+)\s(AM|PM)$/);
  if (sMatch && eMatch && sMatch[2] === eMatch[2]) {
    return `${sMatch[1]}–${eMatch[1]} ${sMatch[2]}`;
  }
  return `${s}–${e}`;
}

// ─── Window formatter ────────────────────────────────────────────────────────

const MAX_BLOCK_MS = 3 * 60 * 60 * 1000; // 3 hours
const MAX_DAYS = 5;
const SLOT_MS = 30 * 60 * 1000;

interface Block {
  start: Date;
  end: Date;
  hasPreferred: boolean;
  preferredCount: number;
}

/**
 * Collapse scored slots into day-grouped availability windows for the greeting.
 *
 * Behavior:
 * - Filters to future, offerable slots (score ≤ 1)
 * - Collapses contiguous 30-min slots into ranges
 * - Marks a range with ★ if any contained slot is preferred (score ≤ -1)
 * - Splits any block wider than ~3 hours (keeps the first 3h — the greeting
 *   should stay skimmable, and the agent can widen the search in later turns)
 * - Returns up to 5 days, prioritizing days with preferred slots and then by
 *   chronological order
 *
 * @param guestTimezone Optional IANA timezone for the GUEST. When set, day
 *   grouping and the primary time label switch to guest-local, with the
 *   host-local time shown in parentheses — "5–7 PM CEST (8–10 AM PT)". When
 *   omitted or equal to the host timezone, behavior is unchanged from
 *   pre-v2 and all existing callers stay correct.
 */
export function formatAvailabilityWindows(
  slots: ScoredSlot[],
  timezone: string,
  now: Date = new Date(),
  guestTimezone?: string,
  durationMin?: number,
  minDurationMin?: number
): FormattedWindows {
  const offerable = slots.filter((s) => {
    const start = new Date(s.start);
    return start > now && s.score <= 1;
  });
  // Remove isolated slots that don't have enough consecutive room for the
  // meeting. When minDuration is set, use it as the floor so short-but-ok
  // windows still appear in the greeting.
  const durationFiltered = durationMin
    ? filterByDuration(offerable, durationMin, minDurationMin)
    : offerable;
  const goodSlots = durationFiltered.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  if (goodSlots.length === 0) return { lines: [], hasPreferred: false, wasTruncated: false };

  let wasTruncated = false;

  // When the guest has a distinct timezone, group by the GUEST's local calendar
  // so "Wednesday 8 PM CEST" doesn't visually split across two days in PT.
  // Time ranges are rendered primary in the guest TZ and secondary in the
  // host TZ via fmtDualTimeRange below.
  const hasGuestTz = !!guestTimezone && guestTimezone !== timezone;
  const groupTz = hasGuestTz ? guestTimezone! : timezone;

  const dayFmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: groupTz,
    });

  // Step 1: build contiguous blocks, grouped by day.
  const dayToBlocks = new Map<string, Block[]>();
  let current: Block | null = null;
  let currentDay: string | null = null;

  const commit = () => {
    if (current && currentDay) {
      if (!dayToBlocks.has(currentDay)) dayToBlocks.set(currentDay, []);
      dayToBlocks.get(currentDay)!.push(current);
    }
  };

  for (const slot of goodSlots) {
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    const dayLabel = dayFmt(start);
    const isPreferred = slot.score <= -1;

    if (
      current &&
      currentDay === dayLabel &&
      start.getTime() === current.end.getTime()
    ) {
      current.end = end;
      if (isPreferred) {
        current.hasPreferred = true;
        current.preferredCount += 1;
      }
    } else {
      commit();
      current = {
        start,
        end,
        hasPreferred: isPreferred,
        preferredCount: isPreferred ? 1 : 0,
      };
      currentDay = dayLabel;
    }
  }
  commit();

  // Step 2: split any block wider than the effective cap. For generic
  // short meetings, cap at 3h so the greeting stays skimmable. For custom
  // long meetings (duration > 3h), lift the cap to match the meeting length —
  // an "afternoon together" invite should show its full afternoon window.
  const effectiveMaxBlockMs = durationMin && durationMin > 180
    ? durationMin * 60 * 1000
    : MAX_BLOCK_MS;
  for (const [day, blocks] of Array.from(dayToBlocks.entries())) {
    const split: Block[] = [];
    for (const b of blocks) {
      const durationMs = b.end.getTime() - b.start.getTime();
      if (durationMs <= effectiveMaxBlockMs) {
        split.push(b);
      } else {
        wasTruncated = true;
        const cutoff = new Date(b.start.getTime() + effectiveMaxBlockMs);
        split.push({
          start: b.start,
          end: cutoff,
          hasPreferred: b.hasPreferred,
          preferredCount: b.preferredCount,
        });
      }
    }
    dayToBlocks.set(day, split);
  }

  // Step 3: score each day and keep the best MAX_DAYS.
  // When the guest is in a different timezone, rank by guest-convenience
  // first: how much of the offered time lands inside the guest-local
  // working window (08:00–19:00 local). That way a Paris guest sees
  // afternoon CET slots (morning PT) first, not the host's "preferred"
  // 10 AM PT slots that fall at 7 PM CET for them.
  const GUEST_WORK_START = 8;
  const GUEST_WORK_END = 19;

  /** Minutes of a block that land inside [workStart, workEnd) in a given tz. */
  function minutesInWorkingWindow(block: Block, rankTz: string): number {
    const startMs = block.start.getTime();
    const endMs = block.end.getTime();
    let total = 0;
    for (let t = startMs; t < endMs; t += SLOT_MS) {
      const slotHour = Number(
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          hour12: false,
          timeZone: rankTz,
        }).format(new Date(t))
      );
      if (slotHour >= GUEST_WORK_START && slotHour < GUEST_WORK_END) {
        total += 30;
      }
    }
    return total;
  }

  interface DayEntry {
    day: string;
    firstStart: Date;
    preferredCount: number;
    totalSlots: number;
    guestWorkingMinutes: number;
    blocks: Block[];
  }
  const days: DayEntry[] = [];
  for (const [day, blocks] of Array.from(dayToBlocks.entries())) {
    if (blocks.length === 0) continue;
    const preferredCount = blocks.reduce((n: number, b: Block) => n + b.preferredCount, 0);
    const totalSlots = blocks.reduce(
      (n: number, b: Block) => n + Math.round((b.end.getTime() - b.start.getTime()) / SLOT_MS),
      0
    );
    const guestWorkingMinutes = hasGuestTz
      ? blocks.reduce((n: number, b: Block) => n + minutesInWorkingWindow(b, guestTimezone!), 0)
      : 0;
    days.push({
      day,
      firstStart: blocks[0].start,
      preferredCount,
      totalSlots,
      guestWorkingMinutes,
      blocks,
    });
  }

  // Ranking: host-preferred slots always come first (they represent explicit
  // host choices — link rules, scored -1 or lower). Within the same preference
  // tier, guest-TZ working hours break ties so the most convenient EDT/CEST/etc.
  // windows surface ahead of chronological order. Final tiebreak: chronological.
  days.sort((a, b) => {
    if (a.preferredCount !== b.preferredCount) {
      return b.preferredCount - a.preferredCount;
    }
    if (hasGuestTz) {
      if (a.guestWorkingMinutes !== b.guestWorkingMinutes) {
        return b.guestWorkingMinutes - a.guestWorkingMinutes;
      }
      if (a.totalSlots !== b.totalSlots) {
        return b.totalSlots - a.totalSlots;
      }
    }
    return a.firstStart.getTime() - b.firstStart.getTime();
  });

  const picked = days.slice(0, MAX_DAYS);
  if (days.length > MAX_DAYS) wasTruncated = true;
  // Re-sort chronologically for display.
  picked.sort((a, b) => a.firstStart.getTime() - b.firstStart.getTime());

  // Short TZ labels are resolved at render time against "now" so DST is
  // handled correctly for both sides.
  const guestShort = hasGuestTz ? shortTimezoneLabel(guestTimezone!, now) : null;
  const hostShort = shortTimezoneLabel(timezone, now);

  // Week grouping: insert "This week:", "Next week:", "Week of May 5:" headers
  // when the offered days span multiple weeks. Uses the grouping timezone so
  // the week boundary matches the day labels the guest sees.
  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function weekMonday(d: Date): string {
    const dow = DOW_NAMES.indexOf(
      new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: groupTz })
        .formatToParts(d)
        .find((p) => p.type === "weekday")!.value
    );
    const offset = dow === 0 ? 6 : dow - 1; // days since Monday
    const mondayMs = d.getTime() - offset * 86400000;
    return new Date(mondayMs).toISOString().slice(0, 10);
  }

  const nowMonday = weekMonday(now);
  const nextMonday = new Date(new Date(nowMonday + "T12:00:00").getTime() + 7 * 86400000)
    .toISOString().slice(0, 10);

  function weekLabel(d: Date): string {
    const mon = weekMonday(d);
    if (mon === nowMonday) return "This week:";
    if (mon === nextMonday) return "Next week:";
    // "Week of May 5:"
    const monDate = new Date(mon + "T12:00:00");
    const label = monDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    return `Week of ${label}:`;
  }

  let hasPreferred = false;
  const lines: string[] = [];
  let currentWeekLabel: string | null = null;
  const needsWeekHeaders = picked.length > 1 &&
    weekMonday(picked[0].firstStart) !== weekMonday(picked[picked.length - 1].firstStart);

  for (const entry of picked) {
    if (needsWeekHeaders) {
      const wl = weekLabel(entry.firstStart);
      if (wl !== currentWeekLabel) {
        currentWeekLabel = wl;
        lines.push(wl);
      }
    }

    const parts = entry.blocks.map((b) => {
      if (!hasGuestTz) {
        const range = fmtTimeRange(b.start, b.end, timezone);
        if (b.hasPreferred) {
          hasPreferred = true;
          return `${range} ★`;
        }
        return range;
      }
      const guestRange = fmtTimeRange(b.start, b.end, guestTimezone!);
      const hostRange = fmtTimeRange(b.start, b.end, timezone);
      const dual = `${guestRange} ${guestShort} (${hostRange} ${hostShort})`;
      if (b.hasPreferred) {
        hasPreferred = true;
        return `${dual} ★`;
      }
      return dual;
    });
    lines.push(`  • ${entry.day} — ${parts.join(", ")}`);
  }

  return { lines, hasPreferred, wasTruncated };
}

// ─── Stretch-day formatter ───────────────────────────────────────────────────

/**
 * Returns a compact, human-readable list of days that have stretch slots
 * (score 2–3). Used by the VIP greeting one-liner.
 *
 * Example: "Tue Apr 22, Wed Apr 23, and Thu Apr 24"
 *
 * Days are grouped using the guest timezone when provided (so the label
 * matches what the guest sees in the widget), otherwise the host timezone.
 */
export function formatStretchDays(
  slots: ScoredSlot[],
  hostTimezone: string,
  now: Date = new Date(),
  guestTimezone?: string,
): string {
  const hasGuestTz = !!guestTimezone && guestTimezone !== hostTimezone;
  const groupTz = hasGuestTz ? guestTimezone! : hostTimezone;

  const dayFmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: groupTz,
    });

  const seen = new Set<string>();
  const days: string[] = [];

  for (const slot of slots) {
    const start = new Date(slot.start);
    if (start <= now) continue;
    const score = slot.score ?? 0;
    if (score < 2 || score > 3) continue;
    const label = dayFmt(start);
    if (!seen.has(label)) {
      seen.add(label);
      days.push(label);
    }
  }

  if (days.length === 0) return "";
  if (days.length === 1) return days[0];
  if (days.length === 2) return `${days[0]} and ${days[1]}`;
  return `${days.slice(0, -1).join(", ")}, and ${days[days.length - 1]}`;
}

// ─── Open-window greeting (guestPicks variant, 2026-04-17) ─────────────────

interface BuildOpenWindowOpts {
  /** Host's first name. Used in the greeting prose. */
  hostFirstName: string;
  /** The guest's display name, or null if unknown. */
  inviteeName: string | null;
  /** Session topic (post-filter for generic terms). Null = no topic. */
  topic: string | null;
  /** Host's timezone IANA for window label rendering. */
  hostTimezone: string;
  /** Guest's timezone if distinct from host; triggers dual-tz window label. */
  guestTimezone?: string;
  /** The window the host specified (e.g., afternoon = 12–17). Optional — if
   *  not set, the greeting just says "any time" (within offerable hours). */
  window?: { startHour: number; endHour: number };
  /** The ISO date (YYYY-MM-DD, host-local) the host anchored to ("today",
   *  "this afternoon" resolves to today's date). Null = open date too. */
  anchorDate?: string | null;
  /** What the guest is being asked to pick. All three flags independent. */
  picks: { date?: boolean; duration?: boolean | number[]; location?: boolean };
  /** Sanitized guidance from the host. `tone` has already been run through
   *  sanitizeHostFlavor at save time. */
  guidance?: {
    suggestions?: { locations?: string[]; durations?: number[] };
    tone?: string;
  };
}

/**
 * Render the open-window greeting used when `link.rules.guestPicks` is set.
 * Replaces the day-bullet windows list with a single sentence naming the
 * host's deferred window + what the guest is choosing. Always terse —
 * never enumerates slots because by definition the host didn't pin one.
 */
export function buildOpenWindowGreeting(opts: BuildOpenWindowOpts): string {
  const {
    hostFirstName,
    inviteeName,
    topic,
    hostTimezone,
    guestTimezone,
    window,
    anchorDate,
    picks,
    guidance,
  } = opts;

  const hostShort = shortTimezoneLabel(hostTimezone, new Date());
  const hasDistinctGuestTz = guestTimezone && guestTimezone !== hostTimezone;
  const guestShort = hasDistinctGuestTz ? shortTimezoneLabel(guestTimezone!, new Date()) : null;

  // Format a window like "afternoon (12–5 PM PDT)" or, when the guest is in a
  // distinct TZ, "12–5 PM PDT (3–8 PM EDT)". Hour-only; we never invent
  // minutes since the host's directive didn't include them.
  function fmtHour(h: number, tz: string): string {
    // Build an arbitrary ISO instant today at hour h in tz, then format. We
    // can use any day — we only need the hour label.
    const d = new Date();
    const iso = `${d.toISOString().slice(0, 10)}T00:00:00Z`;
    // Easier path: just use 12h formatting on a fixed reference.
    const ref = new Date(iso);
    ref.setUTCHours(h);
    return ref.toLocaleTimeString("en-US", { hour: "numeric", timeZone: tz }).replace(":00", "");
  }
  const windowLabel = window
    ? (() => {
        const hostLabel = `${fmtHour(window.startHour, hostTimezone)}–${fmtHour(window.endHour, hostTimezone)} ${hostShort}`;
        if (hasDistinctGuestTz) {
          const guestLabel = `${fmtHour(window.startHour, guestTimezone!)}–${fmtHour(window.endHour, guestTimezone!)} ${guestShort}`;
          return `${guestLabel} (${hostLabel})`;
        }
        return hostLabel;
      })()
    : null;

  // Prose the date anchor if provided. "today", "this afternoon" etc. stay
  // implicit — the LLM layer sends us the ISO date and we resolve from there.
  const dateProse = anchorDate
    ? (() => {
        const today = new Date();
        const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: hostTimezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(today);
        if (anchorDate === todayIso) return "today";
        const anchor = new Date(`${anchorDate}T12:00:00`);
        return anchor.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      })()
    : null;

  // Build the "pick these" clause.
  const toPickParts: string[] = [];
  if (picks.date) toPickParts.push("the day");
  // Start time: always pickable in the open-window variant (that's the point).
  toPickParts.push(picks.date ? "time" : "the start time");
  if (picks.duration === true) toPickParts.push("how long you need");
  else if (Array.isArray(picks.duration) && picks.duration.length > 0) {
    const durs = picks.duration.join(" or ");
    toPickParts.push(`how long (${durs} min)`);
  }
  if (picks.location) toPickParts.push("where");

  const pickClause =
    toPickParts.length === 1
      ? toPickParts[0]
      : toPickParts.length === 2
      ? `${toPickParts[0]} and ${toPickParts[1]}`
      : `${toPickParts.slice(0, -1).join(", ")}, and ${toPickParts[toPickParts.length - 1]}`;

  // Intro line — mirrors the standard greeting's voice.
  const greetee = inviteeName ? inviteeName.split(/\s+/)[0] : "there";
  const topicClause = topic ? ` about ${topic}` : "";
  const intro = `👋 Hi ${greetee}! ${hostFirstName} is making time${topicClause}.`;

  // Anchor line — when / window.
  const anchorBits = [dateProse, windowLabel].filter(Boolean).join(", ");
  const anchorLine = anchorBits
    ? `📅 ${anchorBits}.`
    : `📅 Any time that works for you.`;

  // Tone — ONLY surfaced with a leading "—" beat so it reads as a small
  // grace note, not an instruction. Sanitizer already stripped injection risk.
  const toneLine = guidance?.tone ? ` ${guidance.tone}` : "";

  // Ask line.
  const askLine = `You pick ${pickClause}.`;

  // Location suggestions as a chip-ish prose list.
  const locSugs = guidance?.suggestions?.locations || [];
  const locHint =
    picks.location && locSugs.length > 0
      ? ` A few places ${hostFirstName} suggested: ${locSugs.map((l) => `**${l}**`).join(", ")}.${locSugs.length ? " Pick anything else if you'd prefer." : ""}`
      : "";

  // Closing (matches standard greeting's "share your email" hook when missing).
  const closing = `Share your email and I'll get it on the calendar. 🤝`;

  return [intro + toneLine, anchorLine, askLine + locHint, closing].join("\n\n");
}

// ─── Format label helpers ────────────────────────────────────────────────────

/** "video" → "video call", "phone" → "phone call", "in-person" → "in-person meeting". */
export function formatLabel(format: string | undefined): string | null {
  if (!format) return null;
  if (format === "video") return "video call";
  if (format === "phone") return "phone call";
  if (format === "in-person") return "in-person meeting";
  return format;
}

/**
 * Human-readable alternative-format clause for the "If you'd like..." line.
 * Given the chosen default format, describe the remaining options.
 */
export function alternateFormatsLabel(
  defaultFormat: string | undefined
): string | null {
  if (!defaultFormat) return null;
  if (defaultFormat === "video") return "a call or in-person";
  if (defaultFormat === "phone") return "video or in-person";
  if (defaultFormat === "in-person") return "phone or video";
  return null;
}
