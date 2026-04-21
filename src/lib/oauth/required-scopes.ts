/**
 * Single source of truth for the OAuth scope sets the app declares to Google.
 *
 * Asymmetric by entry point (decision 2026-04-20):
 *   - **Front door** (`/login`, homepage CTA, header sign-in) — read + write
 *     upfront. A user entering via the front door is signing up to host. Asking
 *     for write later in a second consent screen is friction without benefit.
 *   - **Deal-room CTA** (anonymous viewer joining a host's deal room) — read
 *     only. They're connecting their calendar to help a host pick a time, not
 *     to write meetings. They can upgrade to write later if they ever become
 *     a host themselves (via the `upgrade-scope` modal mode).
 *   - **Guest connect** (`/api/auth/guest-calendar`) — unchanged. Anonymous
 *     read-only OAuth that creates no user account. Reserved for future use.
 *
 * Detection consumers (the NextAuth `signIn` callback, the guest-calendar
 * callback) read `Account.scope` returned by Google and check it against the
 * appropriate `*_REQUIRED` set to decide whether the grant is sufficient.
 * Anything in the required set that is missing means the user unticked a box
 * on Google's consent screen.
 */

export const OPENID_BASE = ["openid", "email", "profile"] as const;

export const HOST_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";
export const HOST_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

export const HOST_REQUIRED_FRONT_DOOR = [
  ...OPENID_BASE,
  HOST_WRITE_SCOPE,
  HOST_READ_SCOPE,
] as const;

export const HOST_REQUIRED_FROM_DEAL_ROOM = [
  ...OPENID_BASE,
  HOST_READ_SCOPE,
] as const;

/**
 * Back-compat alias. Most callers want the full host scope set; only the
 * NextAuth `signIn` audit needs to vary by entry point. Prefer the explicit
 * names in new code.
 */
export const HOST_REQUIRED = HOST_REQUIRED_FRONT_DOOR;

/**
 * Reserved for future scopes that improve the host experience but are not
 * load-bearing. Empty today — kept as an explicit slot so callers can call
 * `parseScopes` against the union without a refactor when one is added.
 */
export const HOST_OPTIONAL: readonly string[] = [];

export const GUEST_REQUIRED = [...OPENID_BASE, HOST_READ_SCOPE] as const;

export type HostEntryPoint = "front-door" | "deal-room";

/** Returns the scope set we *expect* a host to have granted, given how they
 *  entered the app. Used by the signIn audit so the dashboard interstitial
 *  doesn't fire for deal-room users (we never asked them for write). */
export function hostRequiredFor(entryPoint: HostEntryPoint): readonly string[] {
  return entryPoint === "deal-room"
    ? HOST_REQUIRED_FROM_DEAL_ROOM
    : HOST_REQUIRED_FRONT_DOOR;
}

export type ScopeAudit = {
  granted: string[];
  missingRequired: string[];
  satisfied: boolean;
};

export function parseScopeString(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return scope.split(/\s+/).filter(Boolean);
}

export function auditScopes(
  scope: string | null | undefined,
  required: readonly string[],
): ScopeAudit {
  const granted = parseScopeString(scope);
  const grantedSet = new Set(granted);
  const missingRequired = required.filter((s) => !grantedSet.has(s));
  return { granted, missingRequired, satisfied: missingRequired.length === 0 };
}

/** Cookie name read by the signIn callback to learn how the user entered.
 *  Set client-side just before `signIn()` is called; auto-expires after 5
 *  minutes so a stale value can't poison a later sign-in. */
export const ENTRY_POINT_COOKIE = "oauth_entry_point";
