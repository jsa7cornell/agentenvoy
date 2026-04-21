/**
 * Same-origin-path validator + CTA callback wrapper for the onboarding
 * returnTo transport. See proposal
 * `2026-04-21_lean-first-run-onboarding-and-returnto_*.md` §2.2 / §2.3.
 *
 * The contract: `?onboardReturnTo=<path>` on `/dashboard` is honored iff it
 * passes `validateReturnTo` — path only, same-origin, no protocol-relative,
 * no Windows separators, no bare fragment. Bad input is silently dropped.
 */

export function validateReturnTo(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  return raw;
}

/**
 * Wrap a sign-in `callbackUrl` so that after Google round-trips we land on
 * `/dashboard?onboardReturnTo=<original>`. The dashboard then either runs
 * onboarding and redirects to `<original>` on completion (uncalibrated
 * user), or immediately bounces to `<original>` (calibrated user).
 */
export function onboardingCallbackUrl(originalCallback: string): string {
  return `/dashboard?onboardReturnTo=${encodeURIComponent(originalCallback)}`;
}
