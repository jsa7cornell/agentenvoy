/**
 * Host first-name resolution — single source of truth.
 *
 * All inline `name.split(/\s+/)[0] || "Host"` (or similar) computations
 * across the codebase must be replaced with this util. Consumer functions
 * that accept `hostFirstName: string` as a parameter should receive their
 * value from this util — verify at every call site.
 *
 * Background: 2026-04-29 bilateral+picker bundle, Decision 2(b). Prior to
 * consolidation there were ~9 inline producer sites computing this from
 * a user record, each with subtly different fallbacks ("Host" vs "the
 * organizer" vs `undefined`). Drift between Sonnet's playbook and the
 * picker's render layer was a stated risk; this util closes it.
 *
 * @example
 *   import { hostFirstName } from "@/lib/host-naming";
 *   const greeting = `${hostFirstName(user)} is open Tuesday at 1 PM.`;
 */
export interface HostNameInput {
  firstName?: string | null;
  name?: string | null;
}

/**
 * Resolve a host's first name for display.
 *
 * Order of precedence:
 *   1. `user.firstName` if present and non-empty after trimming.
 *   2. First whitespace-delimited token of `user.name`.
 *   3. `"Host"` last-resort fallback.
 *
 * @param user - User record (or anything with `firstName?` / `name?`).
 * @returns Trimmed first-name string. Never empty, never `null`.
 */
export function hostFirstName(user: HostNameInput | null | undefined): string {
  if (!user) return "Host";
  const fromFirst = user.firstName?.trim();
  if (fromFirst) return fromFirst;
  const fromName = user.name?.split(/\s+/)[0]?.trim();
  if (fromName) return fromName;
  return "Host";
}
