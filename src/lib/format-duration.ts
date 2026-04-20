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
 * Casual variant for prose greetings — spells out units rather than
 * abbreviating, and uses natural phrases for round hours. Examples:
 *   10 → "10 minutes", 30 → "30 minutes", 60 → "an hour",
 *   90 → "90 minutes" (keep numeric to stay unambiguous),
 *   120 → "2 hours", 180 → "3 hours".
 *
 * Used in the prose-form greeting assembly to match John's casual voice:
 * "He's proposing 10 minutes tomorrow or Thursday." (2026-04-20)
 */
export function formatDurationCasual(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "";
  const total = Math.round(minutes);
  if (total < 60) return `${total} minutes`;
  if (total === 60) return "an hour";
  if (total % 60 === 0) return `${total / 60} hours`;
  return `${total} minutes`;
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
