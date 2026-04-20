/**
 * Canonical duration formatter for user-facing surfaces.
 *
 * Rule: below an hour → "N min" (spelled out, readable).
 *       exactly an hour → "1h".
 *       above an hour → "Xh" or "Xh Ym".
 *
 * Examples: 30 → "30 min", 45 → "45 min", 60 → "1h",
 *           90 → "1h 30m", 120 → "2h", 480 → "8h".
 *
 * Call at every display boundary — thread cards, deal-room event card,
 * greeting prose, emails, tooltip labels, Envoy action confirmations.
 * Centralizes the "how do we talk about durations" rule so it's one edit
 * to change the convention later.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "";
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Variant for contexts where a space-separated "-min" suffix is baked
 * into surrounding copy (e.g. "30-min meeting", "90-min call"). Returns
 * a bare string suitable for `${formatDurationCompact(n)} meeting`.
 *
 * Uses the same rule set but emits tighter tokens ("30-min", "1h",
 * "1h-30m") so the surrounding copy doesn't need to branch.
 */
export function formatDurationCompact(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "";
  const total = Math.round(minutes);
  if (total < 60) return `${total}-min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (m === 0) return `${h}h`;
  return `${h}h-${m}m`;
}
