/**
 * Deterministic greeting template helpers.
 *
 * Used by `src/app/api/negotiate/session/route.ts` to build the first message
 * in a 1:1 deal room without calling an LLM. Exported as standalone functions
 * so they can be unit-tested in isolation.
 */

import type { ScoredSlot } from "@/lib/scoring";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FormattedWindows {
  /** One bullet line per day, e.g. "  • Mon Apr 15 — 10–11:30 AM ★, 2–4 PM" */
  lines: string[];
  /** True if any shown block contains a preferred (score ≤ -1) slot. */
  hasPreferred: boolean;
}

// ─── Timezone label ──────────────────────────────────────────────────────────

/**
 * Render an IANA timezone as a human-readable label.
 *
 * Examples:
 *   America/Los_Angeles  → "Pacific time"
 *   America/New_York     → "Eastern time"
 *   Asia/Kolkata         → "India Standard Time"
 *
 * NEVER returns a raw UTC offset like "GMT-7" — callers rely on this for the
 * guest-facing greeting and offsets look like machine output.
 */
export function humanTimezoneLabel(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "long",
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value || timezone;
    // "Pacific Daylight Time" / "Pacific Standard Time" → "Pacific time"
    // Only collapse when the prefix is a well-known US zone name.
    const simplified = name.replace(
      /\b(Pacific|Eastern|Central|Mountain|Atlantic|Alaska|Hawaii(?:-Aleutian)?)\s+(Daylight|Standard)\s+Time\b/,
      "$1 time"
    );
    return simplified;
  } catch {
    return timezone;
  }
}

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
 */
export function formatAvailabilityWindows(
  slots: ScoredSlot[],
  timezone: string,
  now: Date = new Date()
): FormattedWindows {
  const goodSlots = slots
    .filter((s) => {
      const start = new Date(s.start);
      return start > now && s.score <= 1;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  if (goodSlots.length === 0) return { lines: [], hasPreferred: false };

  const dayFmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: timezone,
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

  // Step 2: split any block wider than ~3 hours. With the input slot stream we
  // can only split on time, not on calendar events — calendar events already
  // force natural gaps (they're filtered out above). This cap applies to the
  // rare "truly empty day" case so the greeting never shows "10 AM–6 PM".
  for (const [day, blocks] of Array.from(dayToBlocks.entries())) {
    const split: Block[] = [];
    for (const b of blocks) {
      const durationMs = b.end.getTime() - b.start.getTime();
      if (durationMs <= MAX_BLOCK_MS) {
        split.push(b);
      } else {
        // Keep the first 3 hours. The agent can widen search on follow-up.
        const cutoff = new Date(b.start.getTime() + MAX_BLOCK_MS);
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
  interface DayEntry {
    day: string;
    firstStart: Date;
    preferredCount: number;
    totalSlots: number;
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
    days.push({
      day,
      firstStart: blocks[0].start,
      preferredCount,
      totalSlots,
      blocks,
    });
  }

  // Prefer days with preferred slots; tiebreak by chronological order.
  days.sort((a, b) => {
    if (a.preferredCount !== b.preferredCount) {
      return b.preferredCount - a.preferredCount;
    }
    return a.firstStart.getTime() - b.firstStart.getTime();
  });

  const picked = days.slice(0, MAX_DAYS);
  // Re-sort chronologically for display.
  picked.sort((a, b) => a.firstStart.getTime() - b.firstStart.getTime());

  let hasPreferred = false;
  const lines = picked.map((entry) => {
    const parts = entry.blocks.map((b) => {
      const range = fmtTimeRange(b.start, b.end, timezone);
      if (b.hasPreferred) {
        hasPreferred = true;
        return `${range} ★`;
      }
      return range;
    });
    return `  • ${entry.day} — ${parts.join(", ")}`;
  });

  return { lines, hasPreferred };
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
