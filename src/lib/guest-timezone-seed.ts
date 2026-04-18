/**
 * Guest-timezone seed resolution.
 *
 * Two decisions live here, sharing the same priority order:
 *
 * 1. What to persist on `session.guestTimezone` at session-create time.
 * 2. What TZ to use for the greeting render (`effectiveGuestTz`).
 *
 * Priority:
 *   - `link.inviteeTimezone` (host declaration) wins.
 *   - Else `session.guestTimezone` (first-observed browser TZ) if already set.
 *   - Else the current request's browser TZ if this is NOT a host-preview.
 *     Host-preview never persists a TZ (isHost guard protects against the
 *     host's laptop TZ corrupting the guest-facing greeting).
 *
 * Declared TZ acts as a soft-lock: once the session persists a TZ, observed
 * browser mismatches do not override it until the greeting re-render path
 * ships (see proposals/2026-04-18_link-invitee-timezone-seed.md).
 */

export interface SeedInputs {
  /** IANA TZ declared by the host on the Link row. Null if unknown. */
  linkInviteeTimezone: string | null;
  /** IANA TZ observed from the current request's browser. May be empty. */
  observedBrowserTimezone: string | null | undefined;
  /** True when the current visitor is the link owner (host preview). */
  isHost: boolean;
}

/**
 * Value to persist on `session.guestTimezone` when CREATING a new session.
 * Returns null if we should leave the column NULL (host-preview with no
 * declaration).
 */
export function resolveSeedGuestTimezoneForCreate(inputs: SeedInputs): string | null {
  if (inputs.linkInviteeTimezone) return inputs.linkInviteeTimezone;
  if (inputs.isHost) return null;
  return inputs.observedBrowserTimezone || null;
}

/**
 * TZ to render the greeting with. Falls back to request-observed TZ even for
 * host-preview (since nothing is persisted, it's just the current display),
 * but declared TZ always wins.
 */
export function resolveEffectiveGuestTimezone(inputs: {
  linkInviteeTimezone: string | null;
  sessionGuestTimezone: string | null;
  observedBrowserTimezone: string | null | undefined;
}): string | undefined {
  return (
    inputs.linkInviteeTimezone ||
    inputs.sessionGuestTimezone ||
    inputs.observedBrowserTimezone ||
    undefined
  );
}
