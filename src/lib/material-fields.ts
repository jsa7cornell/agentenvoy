/**
 * Material fields — fields whose change is meaningful enough to render the
 * "Edited just now — activity, hours" pill on the link/event card.
 *
 * Decided in proposal 2026-04-28_event-edit-handler-and-composer (§3.C).
 *
 * Single source of truth for:
 *  - The action handler's material-edit detection (writes lastMaterialEditAt
 *    and lastEditedFields on NegotiationLink when a patch touches any of
 *    these fields).
 *  - The pill render (which fields to label and how).
 *  - Tests asserting non-material fields don't trigger the pill.
 *
 * Non-material fields (lastResort flips, intent.steering recomputes, etc.)
 * bump `updatedAt` only — not `lastMaterialEditAt`.
 */
export const MATERIAL_FIELDS = [
  "activity",
  "format",
  "duration",
  "location",
  "dateRange",
  "preferredTimeStart",
  "preferredTimeEnd",
  "preferredTimeWindows",
  "preferredDays",
  "blockedRanges",
  "inviteeNames",
  "topic",
  // Added in proposal 2026-04-29_link-handler-consolidation §3.F.4. Host
  // edits that flip guest-deferrals (e.g. "let her choose" → guestPicks.
  // location: true) are material — the "Edited" pill renders them, the
  // follow-up message reaches the active session, and the link card surfaces
  // the change to the host.
  "guestPicks",
  "guestGuidance",
] as const;

export type MaterialField = typeof MATERIAL_FIELDS[number];

/**
 * Humanizer for the pill label. Keeps display copy stable when codebase
 * field names drift. Several timing fields collapse to a single label
 * ("hours") so the pill says "activity, hours" not "activity, hours, hours".
 *
 * Pill render dedupes the output of mapping fields through this map — see
 * humanizeFieldList below.
 */
export const FIELD_LABEL: Record<MaterialField, string> = {
  activity: "activity",
  format: "format",
  duration: "duration",
  location: "location",
  dateRange: "dates",
  preferredTimeStart: "hours",
  preferredTimeEnd: "hours",
  preferredTimeWindows: "hours",
  preferredDays: "days",
  blockedRanges: "blocked time",
  inviteeNames: "guests",
  topic: "title",
  // Both deferral fields collapse to "deferrals" — host who flips multiple
  // guestPicks sub-keys at once sees one pill label, not two.
  guestPicks: "deferrals",
  guestGuidance: "deferrals",
};

/** True if `field` is one of the canonical material fields. */
export function isMaterialField(field: string): field is MaterialField {
  return (MATERIAL_FIELDS as readonly string[]).includes(field);
}

/**
 * Map a list of changed material field names through FIELD_LABEL and dedupe
 * preserving first-seen order. Used by the pill render so callers don't have
 * to repeat the dedupe logic.
 *
 * Example: ["preferredTimeStart","preferredTimeEnd","blockedRanges"]
 *   → ["hours","blocked time"]
 */
export function humanizeFieldList(fields: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fields) {
    if (!isMaterialField(f)) continue;
    const label = FIELD_LABEL[f];
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}
