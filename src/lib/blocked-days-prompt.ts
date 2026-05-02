/**
 * BLOCKED DAYS prompt block — defends against the LLM-fabrication-on-
 * absent-dates bug class.
 *
 * Per proposal `2026-04-25_block-llm-from-offering-non-offerable-days`
 * (deferred to WISHLIST, lifted into 2026-05-01 event-availability proposal
 * as B1 fold). The bug:
 *
 *   - Host creates a link with `availability.restrictToDays: ["Thu", "Fri"]`
 *   - Host's calendar has an all-day event on Thu May 14 → that day is fully
 *     blocked (every slot scores >= 4)
 *   - Guest references "Thu May 14" in chat
 *   - LLM matches the date against `availability.restrictToDays: ["Thu"]`
 *     and fabricates availability — even though no slot from that date
 *     ever appeared in OFFERABLE SLOTS
 *
 * Mitigation: a BLOCKED DAYS prompt block lists explicitly-blocked dates
 * within a 21-day horizon. The composer system prompt teaches the LLM to
 * read this block as a HARD signal — absence from OFFERABLE SLOTS plus
 * presence in BLOCKED DAYS = unavailable, do not propose, regardless of
 * any restrictTo* match.
 *
 * Horizon: 21 days from `now` (matches the existing DATE REFERENCE window
 * in the composer prompt). Days beyond the horizon are not enumerated;
 * the underlying "absence is unavailable" rule still applies via the
 * OFFERABLE SLOTS list itself.
 */

import type { ScoredSlot, LinkParameters } from "./scoring";

export type BlockedDayEntry = {
  /** Local date in YYYY-MM-DD form. */
  date: string;
  /** Local short day name (Mon, Tue, ...). */
  day: string;
  /** Reason — `"all blocked"` (every slot ≥ 4), `"restricted out"` (day not in
   *  restrictToDays), or `"window-only blocked"` (every offerable window slot
   *  blocked). The composer can surface this verbatim in clarifier copy. */
  reason: string;
};

/**
 * Compute BLOCKED DAYS for the next `horizonDays` (default 21) given the
 * scored slots + link rules + host timezone.
 *
 * A day is blocked when ANY of:
 *   - The day is not in `availability.restrictToDays` (when restrictToDays
 *     is set)
 *   - Every slot in the day has score ≥ 4 (deep block — sleep, real events,
 *     blackouts)
 *   - The day has no slot inside any `availability.restrictToWindows` (when
 *     restrictToWindows is set)
 *
 * Days where some slots survive are NOT in the BLOCKED DAYS list —
 * absence from BLOCKED DAYS doesn't mean "available," it means "ask the
 * OFFERABLE SLOTS list for specifics."
 */
export function computeBlockedDays(
  scoredSlots: ScoredSlot[],
  rules: LinkParameters,
  tz: string,
  now: Date = new Date(),
  horizonDays = 21,
): BlockedDayEntry[] {
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  });
  const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz });

  // Bucket slots by local date for fast lookup.
  const slotsByDate = new Map<string, ScoredSlot[]>();
  for (const s of scoredSlots) {
    const date = dateFmt.format(new Date(s.start));
    if (!slotsByDate.has(date)) slotsByDate.set(date, []);
    slotsByDate.get(date)!.push(s);
  }

  const restrictToDays = rules.availability?.restrictToDays;
  const restrictToWindows = rules.availability?.restrictToWindows;

  const result: BlockedDayEntry[] = [];
  for (let i = 0; i < horizonDays; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const date = dateFmt.format(candidate);
    const day = dayFmt.format(candidate);

    // Reason 1 — day not in restrictToDays.
    if (Array.isArray(restrictToDays) && restrictToDays.length > 0) {
      if (!restrictToDays.includes(day as never)) {
        result.push({ date, day, reason: "restricted out" });
        continue;
      }
    }

    const daySlots = slotsByDate.get(date) ?? [];

    // Reason 2 — every slot in the day is in the deep-block band.
    if (daySlots.length > 0 && daySlots.every((s) => s.score >= 4)) {
      result.push({ date, day, reason: "all blocked" });
      continue;
    }

    // Reason 3 — restrictToWindows narrows the day to nothing.
    if (Array.isArray(restrictToWindows) && restrictToWindows.length > 0 && daySlots.length > 0) {
      const anySurvivor = daySlots.some((s) => {
        const t = formatLocalHHMM(new Date(s.start), tz);
        return restrictToWindows.some((w) => t >= w.start && t < w.end);
      });
      if (!anySurvivor) {
        result.push({ date, day, reason: "window-only blocked" });
        continue;
      }
    }
  }
  return result;
}

function formatLocalHHMM(date: Date, tz: string): string {
  // Lightweight formatter matching scoring.ts conventions.
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  });
  // en-US returns "HH:MM" or "24:MM" depending on locale subtleties; force pad.
  const parts = fmt.format(date).split(":");
  const h = parts[0]?.padStart(2, "0") ?? "00";
  const m = parts[1]?.padStart(2, "0") ?? "00";
  return `${h}:${m}`;
}

/**
 * Render the BLOCKED DAYS list as a prompt block. Returns empty string
 * when no days are blocked, so the caller can append unconditionally.
 *
 * Format (matches the deferred 2026-04-25 proposal §3 worked example):
 *
 *   BLOCKED DAYS — these dates fall within the link's day pattern but
 *   have no offerable slot. Do NOT propose any time on these dates,
 *   even if a guest names them directly:
 *     - Thu, May 14, 2026 (all blocked)
 *     - Mon, May 18, 2026 (restricted out)
 *
 * The header copy is intentionally directive — the composer playbook's
 * companion rule ("absence is a hard signal") relies on this framing.
 */
export function renderBlockedDaysPrompt(entries: BlockedDayEntry[], tz: string): string {
  if (entries.length === 0) return "";
  const longDateFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
  const lines = entries.map((e) => {
    const labelDate = longDateFmt.format(new Date(`${e.date}T12:00:00Z`));
    return `  - ${labelDate} (${e.reason})`;
  });
  return [
    "BLOCKED DAYS — these dates fall within the link's day pattern but have no offerable slot. Do NOT propose any time on these dates, even if a guest names them directly:",
    ...lines,
  ].join("\n");
}
