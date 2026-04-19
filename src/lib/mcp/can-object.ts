/**
 * `canObject(session)` — derived, not stored. SPEC §6.
 *
 * Whether the guest can still object to a proposal. The single function
 * over `(status, finalizesAt, supersededByRescheduleId, now)`. No column,
 * no cache, no denormalized bit. Every consumer — route, UI, audit —
 * derives from this same function against the same row.
 *
 * Rules (in order):
 *   1. If `supersededByRescheduleId` is set → false. The session has been
 *      replaced by a reschedule flow; object on the new session instead.
 *   2. If `status` is in a terminal state → false. Terminal means one of:
 *      `agreed`, `rejected`, `cancelled`, `expired`.
 *   3. If `finalizesAt` is present and `now >= finalizesAt` → false. The
 *      host-agreed objection window has elapsed.
 *   4. Otherwise → true.
 */

export type CanObjectInput = {
  status: string;
  finalizesAt: Date | null | undefined;
  supersededByRescheduleId: string | null | undefined;
};

export const TERMINAL_SESSION_STATUSES = new Set([
  "agreed",
  "rejected",
  "cancelled",
  "expired",
]);

export function canObject(session: CanObjectInput, now: Date = new Date()): boolean {
  if (session.supersededByRescheduleId) return false;
  if (TERMINAL_SESSION_STATUSES.has(session.status)) return false;
  if (session.finalizesAt && now.getTime() >= session.finalizesAt.getTime()) {
    return false;
  }
  return true;
}
