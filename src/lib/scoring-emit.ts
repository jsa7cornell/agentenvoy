/**
 * Wire-emit derivation — turns host-stable scored slots + per-link
 * decisions into the integer `slot.score` and boolean `slot.preferred`
 * the wire surfaces emit (MCP `get_availability`, picker data path, etc.).
 *
 * This is the **single source of truth** for emit-time score / preferred
 * derivation. Both MCP tools (`mcp/tools.ts`, `mcp/host-tools.ts`) and the
 * picker data path import from here so neither surface diverges.
 *
 * Per proposal `2026-05-01_event-availability-vs-preferred-vs-calendar-
 * scoring`. Replaces the prior pattern of mutating `slot.score` in
 * `applyEventOverrides` and having each surface independently derive
 * `preferred` from the mutated score (which produced the F10/F13 bug
 * class — see COMPOSER.md §2 entries for context).
 *
 * **Order of operations** (per Round 2 MCP-N3): `deriveEmittedScore` runs
 * at the wire-emit step, AFTER any score-band filters in the consuming
 * surface. The filters continue to read the unmutated host-stable score;
 * only the final emitted integer is derived.
 *
 * SPEC #9 invariants preserved:
 *   ≤ -1  — host-preferred / host-pinned-exclusive
 *    0-1  — bookable
 *    2-3  — VIP backup
 *    ≥ 4  — never emitted (filtered before this step)
 */

import type { ScoredSlot, LinkParameters } from "./scoring";
import {
  inExpansion,
  inPreferred,
  inRestrictToSlots,
} from "./scoring";

/**
 * Derive the integer `slot.score` to emit on the wire.
 *
 * Rules (in order — first match wins):
 *   1. Slot in `availability.restrictToSlots` (host pinned exclusive) → -2
 *   2. Slot in `preferred.{days|windows|slots}` (host preferred) → -1
 *   3. Slot is `expanded` AND base score 2-3 AND off-hours kind → 0
 *   4. Otherwise → unmutated `slot.score`
 *
 * The host-stable `slot.score` from `scoreSlot` is never mutated; this
 * function returns the wire-emit integer, leaving the input slot intact.
 */
export function deriveEmittedScore(
  slot: ScoredSlot,
  rules: LinkParameters,
  tz: string,
): number {
  if (inRestrictToSlots(slot, rules)) return -2;
  if (inPreferred(slot, rules, tz)) return -1;
  if (
    slot.score >= 2 &&
    slot.score <= 3 &&
    slot.kind === "off_hours" &&
    inExpansion(slot, rules, tz)
  ) {
    return 0;
  }
  return slot.score;
}

/**
 * Derive the boolean `slot.preferred` flag to emit on the wire.
 *
 * `true` iff slot is in any preferred source (days / windows / slots) OR
 * is in `availability.restrictToSlots` (host-pinned-exclusive is a
 * preference at the wire level — the host explicitly selected this slot).
 *
 * This makes `slot.preferred` the union of "host explicitly preferred this"
 * and "host explicitly pinned this as the only thing offered" — both
 * surface as `★` in deal-room UI per the 2026-04-21 picks/open/matched
 * tier model.
 */
export function deriveEmittedPreferred(
  slot: ScoredSlot,
  rules: LinkParameters,
  tz: string,
): boolean {
  return inRestrictToSlots(slot, rules) || inPreferred(slot, rules, tz);
}
