/**
 * Single source of truth for the OAuth scope sets the app declares to Google.
 *
 * Two clients are intentional (see proposals/2026-04-20_oauth-onboarding-hygiene…):
 *   - Host signin (NextAuth) requests read + write so confirmed meetings can
 *     land on the user's calendar.
 *   - Guest connect (`/api/auth/guest-calendar`) requests read-only — anonymous
 *     viewers shouldn't grant write access just to find a mutual time.
 *
 * Detection consumers (the NextAuth `signIn` callback, the guest-calendar
 * callback) read `Account.scope` returned by Google and check it against
 * `*_REQUIRED` to decide whether the grant is sufficient. Anything in the
 * `*_REQUIRED` set that is missing means the user unticked a box on Google's
 * consent screen.
 */

export const OPENID_BASE = ["openid", "email", "profile"] as const;

export const HOST_REQUIRED = [
  ...OPENID_BASE,
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

/**
 * Reserved for future scopes that improve the host experience but are not
 * load-bearing. Empty today — kept as an explicit slot so callers can call
 * `parseScopes` against the union without a refactor when one is added.
 */
export const HOST_OPTIONAL: readonly string[] = [];

export const GUEST_REQUIRED = [
  ...OPENID_BASE,
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

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

/**
 * The single scope whose absence we surface most prominently — it's the one
 * that breaks the "AgentEnvoy puts confirmed meetings on your calendar"
 * promise. Used as the `?scopeMissing=` query value when the host denied it.
 */
export const HOST_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";
export const HOST_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";
