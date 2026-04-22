// Density-aware horizon expansion.
//
// When a host is very busy, the standard 14-day window offers few slots.
// This module measures viable slot density and expands the lookout horizon
// so guests always see a useful number of options.
//
// Tiers:
//   SPARSE  (<5 viable days in 14d window)  → extend to 42 days
//   THIN    (<8 viable days in 42d window)  → extend to 90 days
//   NORMAL  → keep 14 days

import type { ScoredSlot } from "@/lib/scoring";

export const HORIZON_NORMAL = 14;
export const HORIZON_SPARSE = 42;
export const HORIZON_THIN = 90;

const VIABLE_SCORE_MAX = 1; // score ≤ 1 = first-offer quality
const SPARSE_DAYS_THRESHOLD = 5;
const THIN_DAYS_THRESHOLD = 8;

/** Returns the lookout horizon in days given the full scored slot list. */
export function computeDensityHorizon(slots: ScoredSlot[]): number {
  const now = Date.now();
  const day14 = now + HORIZON_NORMAL * 86_400_000;
  const day42 = now + HORIZON_SPARSE * 86_400_000;

  const viableDaysIn14 = countViableDays(slots, now, day14);
  if (viableDaysIn14 >= SPARSE_DAYS_THRESHOLD) return HORIZON_NORMAL;

  const viableDaysIn42 = countViableDays(slots, now, day42);
  if (viableDaysIn42 >= THIN_DAYS_THRESHOLD) return HORIZON_SPARSE;

  return HORIZON_THIN;
}

function countViableDays(slots: ScoredSlot[], fromMs: number, toMs: number): number {
  const days = new Set<string>();
  for (const slot of slots) {
    const t = new Date(slot.start).getTime();
    if (t < fromMs || t >= toMs) continue;
    if ((slot.score ?? 0) > VIABLE_SCORE_MAX) continue;
    days.add(slot.start.slice(0, 10));
  }
  return days.size;
}
