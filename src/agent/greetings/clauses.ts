/**
 * Pure clause-builders for greeting templates.
 *
 * Extracted 2026-05-03 from `session/route.ts:944-1041` per [GREETINGS.md §11.A].
 * Templates in `registry.ts` call these directly; the route handler passes
 * raw inputs (`guestPicks`, `guestGuidance`, scoring counts) instead of
 * pre-rendering clauses inline.
 *
 * Each function returns either the rendered clause string or `null` when the
 * inputs don't warrant the clause. Templates compose the returned strings
 * directly — no further gating logic in the templates beyond template-shape
 * (e.g. proposal vs find-time).
 *
 * Helpers are split by clause rather than by template so a new template
 * variant can mix-and-match without duplicating the gating logic.
 */

import { formatDeferralFieldsList, type DeferralFieldNoun } from "./registry";

// ─── Shared input shapes ─────────────────────────────────────────────────────

/**
 * Subset of `link.parameters.guestPicks` that the clause builders consume.
 * Mirrors the shape extracted in `session/route.ts:895-897`.
 */
export interface GuestPicksConfig {
  window?: { startHour: number; endHour: number };
  date?: boolean;
  duration?: boolean | number[];
  location?: boolean;
  format?: boolean | string[];
}

/**
 * Subset of `link.parameters.guestGuidance` that the clause builders consume.
 * Mirrors the shape extracted in `session/route.ts:898-900`.
 */
export interface GuestGuidanceConfig {
  suggestions?: {
    locations?: string[];
    durations?: number[];
  };
  tone?: string;
}

// Cleaner readability for the gating predicates:
const isDuration = (v: GuestPicksConfig["duration"]): boolean =>
  v === true || (Array.isArray(v) && v.length > 0);

const isFormat = (v: GuestPicksConfig["format"]): boolean =>
  v === true || Array.isArray(v);

// ─── Clause: "Let me know where works for you[ — host suggested X]." ─────────

/**
 * "Let me know where works for you — John suggested Sightglass."
 *
 * Folds the legacy `hasGuestPicks` / `buildOpenWindowGreeting` open-window
 * pattern (deleted 2026-04-23) into a single inline hint. Date-pick is
 * intentionally suppressed — the calendar widget IS the day picker.
 *
 * Returns `null` when:
 *   - `guestPicks` is unset, or
 *   - neither location nor duration is opt-in, or
 *   - the clause is suppressed by the unified `deferralFieldsList` (caller
 *     decides — see registry.ts proposal/find-time templates).
 *
 * **Unreachable in current production.** The 2026-04-29 unified-opener fold
 * routes any non-empty `guestPicks.{location|duration|format}` through
 * `buildDeferralFieldsList`, which the proposal/find-time templates use to
 * suppress this clause. Retained because (a) the gating logic is the
 * authoritative copy if a future refactor un-deprecates the path, (b) the
 * code is small and well-isolated, and (c) deleting it requires deleting
 * the corresponding suppression logic in registry.ts which is harder to
 * un-do than to leave dormant. See [GREETINGS.md §11.A] for the full
 * dead-code observation.
 */
export function buildGuestPickHint(input: {
  guestPicks: GuestPicksConfig | null;
  guestGuidance: GuestGuidanceConfig | null;
  hostFirstName: string;
}): string | null {
  const { guestPicks, guestGuidance, hostFirstName } = input;
  if (!guestPicks) return null;
  const locPick = !!guestPicks.location;
  const durPick = isDuration(guestPicks.duration);

  let lead: string | null = null;
  if (locPick && durPick) lead = "where and how long works for you";
  else if (locPick) lead = "where works for you";
  else if (durPick) lead = "how long works for you";
  if (!lead) return null;

  let hint = `Let me know ${lead}`;
  const locSugs = guestGuidance?.suggestions?.locations || [];
  if (locPick && locSugs.length > 0) {
    if (locSugs.length === 1) {
      hint += ` — ${hostFirstName} suggested ${locSugs[0]}`;
    } else if (locSugs.length === 2) {
      hint += ` — ${hostFirstName} suggested ${locSugs[0]} or ${locSugs[1]}`;
    } else {
      hint += ` — ${hostFirstName} suggested ${locSugs.slice(0, -1).join(", ")}, or ${locSugs[locSugs.length - 1]}`;
    }
  }
  return `${hint}.`;
}

// ─── Clause: "and feel free to suggest a different format..." ────────────────

/**
 * "and feel free to suggest a different format or meeting length if that's
 * better for you" — the named-invitee suggest-alt closing fragment.
 *
 * Gated on:
 *   - non-directive steering (skipped for narrow / exclusive)
 *   - non-office-hours (anonymous reusable links use a separate seeded
 *     follow-up message — see 2026-04-28 reusable-link guest-picks proposal)
 *   - at least one of `guestPicks.format` or `guestPicks.duration` opt-in
 *
 * Returns `null` when none of the above conditions are met. The caller decides
 * whether to suppress this further when `deferralFieldsList` is set (the
 * unified-opener path absorbs the same information).
 *
 * **Unreachable in current production** — see `buildGuestPickHint` note above.
 */
export function buildSuggestAltClause(input: {
  guestPicks: GuestPicksConfig | null;
  isDirective: boolean;
  isOfficeHoursLink: boolean;
}): string | null {
  const { guestPicks, isDirective, isOfficeHoursLink } = input;
  if (isDirective || isOfficeHoursLink) return null;
  if (!guestPicks) return null;
  const fmtPick = !!guestPicks.format;
  const durPick = isDuration(guestPicks.duration);
  if (!fmtPick && !durPick) return null;
  if (fmtPick && durPick)
    return "and feel free to suggest a different format or meeting length if that's better for you";
  if (fmtPick)
    return "and feel free to suggest a different format if that's better for you";
  return "and feel free to suggest a different meeting length if that's better for you";
}

// ─── Clause: "the location and length" deferral list ─────────────────────────

/**
 * Unified deferral-fields list for the proposal/find-time opener and closing.
 *
 * "the location" / "the length and location" / "the location, length, and format".
 * Returns `null` when no fields are deferred — caller falls back to the
 * non-deferral copy ("Pick a time below.").
 *
 * Skipped for office-hours and directive (single-slot-lock) links since
 * neither expects guest input on these dimensions. Date deferral is
 * intentionally NOT inserted — the calendar widget IS the day picker.
 *
 * Decided 2026-04-29 (`2026-04-29_link-handler-consolidation`) per John's
 * feedback that Larry's greeting was silent on the deferred location.
 */
export function buildDeferralFieldsList(input: {
  guestPicks: GuestPicksConfig | null;
  isDirective: boolean;
  isOfficeHoursLink: boolean;
}): string | null {
  const { guestPicks, isDirective, isOfficeHoursLink } = input;
  if (isDirective || isOfficeHoursLink) return null;
  const deferred: DeferralFieldNoun[] = [];
  if (guestPicks?.location === true) deferred.push("location");
  if (isDuration(guestPicks?.duration)) deferred.push("length");
  if (isFormat(guestPicks?.format)) deferred.push("format");
  return formatDeferralFieldsList(deferred);
}

// ─── Clause: "Also, if you connect your calendar..." ─────────────────────────

/**
 * Calendar-connect pitch shown only when there's >1 bookable slot AND the
 * viewer is anonymous (logged-in guests already have app-level calendar
 * access). Appended to the proposal/find-time/anonymous closings.
 */
export function buildCalendarPitch(input: {
  bookableSlotCount: number;
  isGuest: boolean;
}): string | null {
  const { bookableSlotCount, isGuest } = input;
  if (bookableSlotCount <= 1) return null;
  if (isGuest) return null;
  return "Also, if you connect your calendar I can automagically find the best fit for you! 🗓️";
}
