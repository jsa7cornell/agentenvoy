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

// ─── Bulleted slot-list formatter (greeting V2, 2026-04-18) ─────────────────
//
// Danny-spec greeting format:
//
//   **Mon, Apr 27**
//   • 6:00 AM PT / 9:00 AM ET
//   • 7:30 AM PT / 10:30 AM ET
//
// Differences vs. formatAvailabilityWindows (the V1 block-range formatter):
//   - One bullet per contiguous block's start time (not a collapsed range).
//     "6–9 AM" becomes a single bullet "6:00 AM" — readers don't need the
//     full range on the first read; they need a pickable start time.
//   - Days are bold markdown headers, one per line.
//   - Dual-timezone renders inline "H:MM AM ZZ / H:MM AM ZZ" (not parens).
//   - Same-timezone collapses to a single label per bullet.
//   - Max 5 bullets per day, max 5 days total; preferred-scored blocks rank
//     first within a day so the guest sees host-favored times ahead of merely
//     available ones.

export interface FormattedSlotList {
  /** Output lines ready to join with "\n". Day headers are bolded, bullets
   *  are prefixed with "• ". No leading indent. */
  lines: string[];
  /** True if any shown bullet corresponds to a preferred slot (score ≤ -1). */
  hasPreferred: boolean;
  /** True if we truncated (more than maxSlotsPerDay blocks on some day, or
   *  more than maxDays days in the offer window). */
  hasMore: boolean;
  /** True if the host timezone label was shown; identical to
   *  `guestTimezone != null && guestTimezone !== hostTimezone`. Callers use
   *  this to tailor header copy. */
  isDualTimezone: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
/** "6:00 AM PT" — single-slot label (kept as reference; multi-slot uses fmtBlockLabel). */
function fmtSlotLabel(d: Date, timezone: string, tzShort: string): string {
  const t = d
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    });
  return `${t} ${tzShort}`;
}

/**
 * Range label for a merged contiguous block — "7:00 AM – 4:00 PM PT".
 *
 * Regression fix 2026-04-20: the Danny-spec V2 greeting (shipped 2026-04-18)
 * emitted only the block's start time. For a day with 7 AM–4 PM wide open,
 * the guest saw `• 7:00 AM PT` and reasonably read that as "one 30-min slot
 * at 7 AM" when it was actually "9 hours of wide-open availability." The
 * pre-V2 greeting did show ranges ("10 AM–1 PM EDT") — we're restoring that
 * for multi-slot blocks while keeping single-slot labels bare.
 */
function fmtBlockLabel(
  start: Date,
  end: Date,
  timezone: string,
  tzShort: string,
): string {
  const startStr = start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  // A "single-slot block" is one 30-min slot wide (≤30 min). Anything larger
  // is a merged block and deserves a range so the guest understands the span.
  const spanMin = (end.getTime() - start.getTime()) / 60000;
  if (spanMin <= 30) {
    return `${startStr} ${tzShort}`;
  }
  const endStr = end.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  return `${startStr} – ${endStr} ${tzShort}`;
}

/**
 * Render a Danny-spec availability list: bolded day headers + bulleted
 * start times, dual- or single-timezone aware. See block comment above for
 * the full format contract.
 *
 * Ranking within a day favors preferred slots (score ≤ -1) ahead of regular
 * openness, tiebreak chronological. Days are sorted chronologically for
 * display after selection.
 */
export function formatAvailabilitySlotList(
  slots: ScoredSlot[],
  hostTimezone: string,
  now: Date = new Date(),
  guestTimezone?: string,
  durationMin?: number,
  minDurationMin?: number,
  opts?: { maxSlotsPerDay?: number; maxDays?: number },
): FormattedSlotList {
  const MAX_SLOTS_PER_DAY = opts?.maxSlotsPerDay ?? 5;
  const MAX_DAYS_LOCAL = opts?.maxDays ?? MAX_DAYS;

  const offerable = slots.filter((s) => {
    const start = new Date(s.start);
    return start > now && s.score <= 1;
  });
  const durationFiltered = durationMin
    ? filterByDuration(offerable, durationMin, minDurationMin)
    : offerable;
  const good = durationFiltered.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  if (good.length === 0) {
    return { lines: [], hasPreferred: false, hasMore: false, isDualTimezone: false };
  }

  const hasGuestTz = !!guestTimezone && guestTimezone !== hostTimezone;
  const groupTz = hasGuestTz ? guestTimezone! : hostTimezone;

  const dayFmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: groupTz,
    });

  // Build contiguous blocks grouped by day. Each block = one bullet.
  interface Block {
    start: Date;
    end: Date;
    hasPreferred: boolean;
    preferredCount: number;
  }
  const dayToBlocks = new Map<string, Block[]>();
  let current: Block | null = null;
  let currentDay: string | null = null;
  const commit = () => {
    if (current && currentDay) {
      if (!dayToBlocks.has(currentDay)) dayToBlocks.set(currentDay, []);
      dayToBlocks.get(currentDay)!.push(current);
    }
  };
  for (const slot of good) {
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

  // Rank days chronologically (list order), cap to maxDays.
  const dayEntries = Array.from(dayToBlocks.entries()).map(([day, blocks]) => ({
    day,
    blocks,
    firstStart: blocks[0].start,
  }));
  dayEntries.sort((a, b) => a.firstStart.getTime() - b.firstStart.getTime());
  let hasMore = dayEntries.length > MAX_DAYS_LOCAL;
  const pickedDays = dayEntries.slice(0, MAX_DAYS_LOCAL);

  const hostShort = shortTimezoneLabel(hostTimezone, now);
  const guestShort = hasGuestTz ? shortTimezoneLabel(guestTimezone!, now) : null;

  const lines: string[] = [];
  let hasPreferred = false;

  for (let i = 0; i < pickedDays.length; i++) {
    const entry = pickedDays[i];
    if (i > 0) lines.push(""); // blank line between day groups
    lines.push(`**${entry.day}**`);

    // Pick up to N bullets: preferred-first, then chronological.
    const sorted = entry.blocks.slice().sort((a, b) => {
      if (a.hasPreferred !== b.hasPreferred) return a.hasPreferred ? -1 : 1;
      return a.start.getTime() - b.start.getTime();
    });
    if (sorted.length > MAX_SLOTS_PER_DAY) hasMore = true;
    const chosen = sorted.slice(0, MAX_SLOTS_PER_DAY);
    // Re-sort chronologically for display.
    chosen.sort((a, b) => a.start.getTime() - b.start.getTime());

    for (const block of chosen) {
      const hostLabel = fmtBlockLabel(block.start, block.end, hostTimezone, hostShort);
      if (hasGuestTz) {
        const guestLabel = fmtBlockLabel(block.start, block.end, guestTimezone!, guestShort!);
        const star = block.hasPreferred ? " ★" : "";
        if (block.hasPreferred) hasPreferred = true;
        lines.push(`• ${guestLabel} / ${hostLabel}${star}`);
      } else {
        const star = block.hasPreferred ? " ★" : "";
        if (block.hasPreferred) hasPreferred = true;
        lines.push(`• ${hostLabel}${star}`);
      }
    }
  }

  return { lines, hasPreferred, hasMore, isDualTimezone: hasGuestTz };
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
  /** Meeting format emoji ("📞" / "📹" / "🤝" / "📅") chosen by the caller. */
  formatEmoji?: string;
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
  /** Host-supplied framing surfaced verbatim as a 💬 line. Sanitized at
   *  create_link time. Null/empty = line omitted. */
  hostNote?: string | null;
}

/** "hike" → "a hike", "adventure" → "an adventure". Leaves phrases alone
 *  when they already carry an article/determiner so we don't double-up. */
function articled(noun: string): string {
  const trimmed = noun.trim();
  if (!trimmed) return trimmed;
  if (/^(a|an|the|this|that|some|our|your|my|his|her|their)\s/i.test(trimmed)) {
    return trimmed;
  }
  const art = /^[aeiouAEIOU]/.test(trimmed) ? "an" : "a";
  return `${art} ${trimmed}`;
}

/**
 * Render the full open-window (guestPicks) greeting — intro + anchor + ask.
 * Replaces the standard day-bullet scheduleBlock when the host has deferred
 * details to the guest. Preserves the host's ambiguity instead of artificially
 * pinning a narrow offer.
 *
 * Email is deliberately NOT requested here — it's collected by the confirm
 * card flow when the guest locks a time, not up front.
 */
export function buildOpenWindowGreeting(opts: BuildOpenWindowOpts): string {
  const {
    hostFirstName,
    inviteeName,
    topic,
    formatEmoji,
    hostTimezone,
    guestTimezone,
    window,
    anchorDate,
    picks,
    guidance,
    hostNote,
  } = opts;

  const hostShort = shortTimezoneLabel(hostTimezone, new Date());
  const hasDistinctGuestTz = guestTimezone && guestTimezone !== hostTimezone;
  const guestShort = hasDistinctGuestTz ? shortTimezoneLabel(guestTimezone!, new Date()) : null;

  // Render an hour given in HOST-LOCAL 24h form as a 12h label in the target
  // timezone. Critical: the previous version used setUTCHours(h) which
  // treated `h` as a UTC hour and produced completely wrong labels (noon
  // host-local rendered as "5 AM" for PDT hosts). We now resolve today's
  // host-local-to-UTC offset and build a real UTC instant.
  function hostHourIn(targetTz: string, h: number): string {
    const ref = new Date();
    const hostNowH = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: hostTimezone,
      }).format(ref),
    );
    const utcNowH = ref.getUTCHours();
    let hostDelta = hostNowH - utcNowH;
    if (hostDelta > 12) hostDelta -= 24;
    if (hostDelta < -12) hostDelta += 24;
    const utcHour = ((h - hostDelta) % 24 + 24) % 24;
    const instant = new Date(ref);
    instant.setUTCHours(utcHour, 0, 0, 0);
    return instant
      .toLocaleTimeString("en-US", { hour: "numeric", timeZone: targetTz })
      .replace(":00", "");
  }

  const windowLabel = window
    ? (() => {
        const hostLabel = `${hostHourIn(hostTimezone, window.startHour)}–${hostHourIn(hostTimezone, window.endHour)} ${hostShort}`;
        if (hasDistinctGuestTz) {
          const guestLabel = `${hostHourIn(guestTimezone!, window.startHour)}–${hostHourIn(guestTimezone!, window.endHour)} ${guestShort}`;
          return `${guestLabel} (${hostLabel})`;
        }
        return hostLabel;
      })()
    : null;

  const dateProse = anchorDate
    ? (() => {
        const today = new Date();
        const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: hostTimezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(today);
        if (anchorDate === todayIso) return "today";
        const anchor = new Date(`${anchorDate}T12:00:00`);
        return anchor.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      })()
    : null;

  // Anchor line — phrased as a WINDOW, not as an event duration. We want
  // "open anytime today between 12–5 PM PDT" to read as "John's window of
  // availability," not as "a 5-hour meeting."
  const anchorLine = (() => {
    if (windowLabel && dateProse) {
      return `📅 Open anytime ${dateProse} between ${windowLabel}.`;
    }
    if (windowLabel) {
      return `📅 Open anytime between ${windowLabel}.`;
    }
    if (dateProse) {
      return `📅 ${hostFirstName} is open ${dateProse}.`;
    }
    return `📅 Any time that works.`;
  })();

  // Tone grace-note on the anchor line. Sanitizer already stripped URLs,
  // emails, injection markers.
  const toneSuffix = guidance?.tone ? ` ${guidance.tone}` : "";

  // Intro — thread the topic through when we have one so context like
  // "hike" flows to the guest. Without topic we fall back to a generic
  // "find time" since format/duration are often deferred in this branch.
  const greetee = inviteeName ? inviteeName.split(/\s+/)[0] : "there";
  const hello = `👋 Hi ${greetee}!`;
  const emoji = formatEmoji ? ` ${formatEmoji}` : "";
  const intro = topic
    ? `${hello}${emoji} I'm helping ${hostFirstName} plan ${articled(topic)} with you.`
    : `${hello}${emoji} I'm helping ${hostFirstName} find time with you.`;

  // Build "Pick a time and location" style ask.
  const items: string[] = [];
  if (picks.date) items.push("day");
  items.push("time");
  if (picks.duration === true) items.push("duration");
  else if (Array.isArray(picks.duration) && picks.duration.length > 0) {
    items.push(`duration (${picks.duration.join(" or ")} min)`);
  }
  if (picks.location) items.push("location");

  const pickClause =
    items.length === 1
      ? `a ${items[0]}`
      : items.length === 2
      ? `a ${items[0]} and ${items[1]}`
      : `a ${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;

  const locSugs = guidance?.suggestions?.locations || [];
  const locHint =
    picks.location && locSugs.length > 0
      ? ` A few places ${hostFirstName} suggested: ${locSugs.map((l) => `**${l}**`).join(", ")}.`
      : "";

  const askLine = `Pick ${pickClause}, and I'll get it booked. 🤝${locHint}`;

  const hostNoteLine = formatHostNoteLine({ hostFirstName, hostNote });
  const blocks = [intro];
  if (hostNoteLine) blocks.push(hostNoteLine);
  blocks.push(anchorLine + toneSuffix, askLine);
  return blocks.join("\n\n");
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

/**
 * Format the host-note line surfaced verbatim in the greeting header.
 * Returns null when there's no note. Sanitization happens upstream at
 * create_link time (see sanitizeHostFlavor); this function only formats.
 *
 * Shape: `💬 {hostFirstName}: {hostNote}` — colon attribution mirrors the
 * existing emoji-prefix pattern (🕒, 📞, 📍).
 */
export function formatHostNoteLine(input: {
  hostFirstName: string;
  hostNote: string | null | undefined;
}): string | null {
  const note = (input.hostNote || "").trim();
  if (!note) return null;
  const who = input.hostFirstName?.trim() || "Host";
  return `💬 ${who}: ${note}`;
}
