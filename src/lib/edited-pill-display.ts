import { humanizeFieldList } from "@/lib/material-fields";

/**
 * Pure display logic for the "Edited just now — activity, hours" pill.
 *
 * Lives outside the React component so we can unit-test the freshness +
 * humanizer + age-bucket math without standing up jsdom + testing-library.
 *
 * Decided in proposal 2026-04-28_event-edit-handler-and-composer (§3.C).
 * The component at `@/components/edited-pill` is a thin React wrapper.
 */

export const EDITED_PILL_DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

export interface EditedPillDisplay {
  ageLabel: string;
  fieldList: string;
}

export interface ComputeEditedPillDisplayOpts {
  /** Current "now" in ms. Pass `Date.now()` from the component; tests pass a fixed value. */
  nowMs: number;
  /** Freshness window in ms. Default 5 minutes. */
  freshnessWindowMs?: number;
}

/**
 * Returns a display object when the pill should render, or null when it
 * shouldn't. Single function — caller renders or skips based on the result.
 *
 * Returns null when:
 *   - `lastMaterialEditAt` is null or unparseable
 *   - The edit is older than the freshness window
 *   - The edit timestamp is in the future (clock-skew defense)
 *   - `lastEditedFields` resolves to zero canonical material entries
 */
export function computeEditedPillDisplay(
  lastMaterialEditAt: string | null | undefined,
  lastEditedFields: readonly string[] | null | undefined,
  opts: ComputeEditedPillDisplayOpts,
): EditedPillDisplay | null {
  if (!lastMaterialEditAt) return null;
  const editedAtMs = Date.parse(lastMaterialEditAt);
  if (Number.isNaN(editedAtMs)) return null;

  const freshness = opts.freshnessWindowMs ?? EDITED_PILL_DEFAULT_FRESHNESS_MS;
  const ageMs = opts.nowMs - editedAtMs;
  if (ageMs > freshness) return null;
  if (ageMs < 0) return null;

  const labels = humanizeFieldList(lastEditedFields ?? []);
  if (labels.length === 0) return null;

  return {
    ageLabel: formatAgeLabel(ageMs),
    fieldList: labels.join(", "),
  };
}

/**
 * Render the relative-time label. Coarse buckets — pill is ephemeral so
 * sub-minute precision isn't useful.
 *
 *   <60s      → "just now"
 *   60..119s  → "1 min ago"
 *   ≥120s     → "N min ago"
 */
function formatAgeLabel(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "1 min ago";
  return `${minutes} min ago`;
}
