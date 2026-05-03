/**
 * Surviving greeting helpers — three small pure functions that pre-date
 * the unified greeting framework but still have production callers.
 *
 * Trim history (2026-05-03):
 *   Five exports + their internal helpers (~1090 LOC) were deleted in this
 *   pass. They served the bulleted-schedule-body greeting that was retired
 *   2026-04-23 when the deterministic registry framework shipped at
 *   `src/agent/greetings/registry.ts`. The deleted exports were:
 *     - formatAvailabilityWindows / FormattedWindows (+ Block, fmtTimeShort,
 *       fmtTimeRange, MAX_BLOCK_MS / MAX_DAYS / SLOT_MS constants)
 *     - formatAvailabilitySlotList / FormattedSlotList / fmtBlockLabel
 *     - formatStretchDays
 *     - formatAvailabilityProse / FormattedProse / relativeDayLabel / joinWithOr
 *     - buildOpenWindowGreeting / BuildOpenWindowOpts / articled
 *     - alternateFormatsLabel (test-only since 2026-04-23)
 *     - formatHostNoteLine (deprecated 2026-04-20 narration-hygiene-v2)
 *
 *   The trim removed ~960 LOC from this file and ~530 LOC of tests
 *   (`host-note.test.ts` deleted; the `formatAvailabilityWindows` /
 *   `formatAvailabilitySlotList` / `formatAvailabilityProse` /
 *   `alternateFormatsLabel` describe blocks dropped from
 *   `greeting-template.test.ts`). Verified zero production callers via grep
 *   before deletion. See [GREETINGS.md §11.C] for the audit notes.
 *
 * If you're adding a new greeting helper, do NOT add it here. The unified
 * framework is at `src/agent/greetings/registry.ts` — extend the templates
 * there. Recurrence-specific helpers live in `src/lib/format-recurrence.ts`.
 * Duration helpers live in `src/lib/format-duration.ts`.
 */

// ─── Timezone label ──────────────────────────────────────────────────────────

// Re-export the canonical long-label helper so existing call sites don't have
// to change. New code should import `longTimezoneLabel` from "@/lib/timezone".
export { longTimezoneLabel as humanTimezoneLabel } from "./timezone";

// ─── Format label ────────────────────────────────────────────────────────────

/**
 * Map a meeting-format token to a guest-facing noun phrase used in greeting
 * prose ("a video call", "an in-person meeting", etc.). Returns null when the
 * format is unset so callers can fall through to a non-format-specific copy.
 */
export function formatLabel(format: string | undefined): string | null {
  if (!format) return null;
  if (format === "video") return "video call";
  if (format === "phone") return "phone call";
  if (format === "in-person") return "in-person meeting";
  return format;
}

// ─── Canonical week label (narration-hygiene-v2 S1, 2026-04-20) ──────────────

/**
 * Given the actual filtered slots being offered and the host's timezone,
 * return a canonical "this week" / "next week" label if the slots fall
 * entirely within one of those buckets (Monday-to-Sunday, relative to
 * today in the host's tz). Returns null when the range is wider or
 * ambiguous — caller falls back to the LLM-authored label.
 *
 * Why: the create_link LLM sometimes parrots ambiguous host phrasing
 * ("next week" said on a Sunday, meaning the week after) into
 * `linkRules.timingLabel`. The greeting template used to echo that string
 * verbatim, which leaked the ambiguity into the guest greeting. This helper
 * lets the greeting override the LLM when we can *prove* what week is being
 * offered by inspecting the actual slots.
 */
export function computeCanonicalWeekLabel(
  slots: Array<{ start: number | Date | string }>,
  hostTimezone: string,
  now: Date = new Date(),
): "this week" | "next week" | null {
  if (!slots || slots.length === 0) return null;

  const weekStartOf = (d: Date): Date => {
    // Monday-starting week in the host's tz.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: hostTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    }).formatToParts(d);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const day = Number(parts.find((p) => p.type === "day")?.value);
    const wk = parts.find((p) => p.type === "weekday")?.value || "Mon";
    const weekdayIdx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wk);
    const base = new Date(Date.UTC(y, m - 1, day));
    base.setUTCDate(base.getUTCDate() - (weekdayIdx < 0 ? 0 : weekdayIdx));
    return base;
  };

  const sameWeek = (a: Date, b: Date) => a.getTime() === b.getTime();
  const nowWeek = weekStartOf(now);
  const nextWeek = new Date(nowWeek);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);

  const toDate = (v: number | Date | string): Date =>
    v instanceof Date ? v : new Date(v);
  const firstStart = toDate(slots[0].start);
  const lastStart = toDate(slots[slots.length - 1].start);

  const firstWeek = weekStartOf(firstStart);
  const lastWeek = weekStartOf(lastStart);

  // Only emit a canonical label when all slots fall in the same week.
  if (!sameWeek(firstWeek, lastWeek)) return null;
  if (sameWeek(firstWeek, nowWeek)) return "this week";
  if (sameWeek(firstWeek, nextWeek)) return "next week";
  return null;
}
