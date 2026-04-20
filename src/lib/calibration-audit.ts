/**
 * Tiny audit wrapper for every write to `User.lastCalibratedAt`.
 *
 * Why: `lastCalibratedAt` is a single nullable timestamp that gates the
 * entire dashboard (feed.tsx:120 — if NULL, the user is forced back into
 * onboarding). When John's production row flipped to NULL on 2026-04-19
 * with no code path in the current repo that writes NULL outside a
 * prod-guarded debug route, we had no way to reconstruct what happened.
 *
 * This helper logs every set (to NOW or NULL) along with the caller tag
 * so a recurrence shows up in Vercel runtime logs immediately and we can
 * skip the guessing game next time.
 *
 * Intentionally thin — it just logs. The Prisma update is still done at
 * the call site so the surrounding transaction/shape stays intact.
 */
export function logCalibrationWrite(params: {
  userId: string;
  /** What the column is being set to. Pass the literal Date you're writing
   *  (or null for a clear). Don't pass `new Date()` twice — the logged and
   *  written values must match. */
  value: Date | null;
  /** Short free-text tag identifying the caller. Used when searching logs.
   *  e.g. "onboarding-complete", "tuner-preferences", "guest-calendar-link",
   *  "agent-action-save-knowledge", "debug-reset". */
  source: string;
}): void {
  const { userId, value, source } = params;
  const verb = value === null ? "CLEAR" : "SET";
  // Log at warn level for the NULL case — that's the one we care about most
  // (a surprise clear is the bug class we've seen in production).
  const log = value === null ? console.warn : console.info;
  log(
    `[calibration-audit] ${verb} lastCalibratedAt user=${userId} source=${source} value=${
      value === null ? "null" : value.toISOString()
    }`,
  );
}
