/**
 * Seed defaults for a newly created user. See proposal
 * `2026-04-21_lean-first-run-onboarding-and-returnto_*.md` §2.7.
 *
 * Written from `events.createUser` so a fresh user lands with sensible
 * defaults already set. The seed-preview is inlined on the `complete`
 * onboarding message (post-2026-04-23 sunset of `defaults_confirm`;
 * proposal `2026-04-23_primary-link-config-convergence` §4 V1 item 5);
 * users tune via the welcome page's 🔗 primary-link flow or chat.
 *
 * Fields NOT seeded (any default is more likely wrong than right): `phone`,
 * `zoomLink`, eveningsPosture. Proposal 3 gap-detectors pick these up
 * contextually when they're first needed.
 *
 * Shape matches what `preferences.explicit.*` looks like elsewhere in the
 * codebase — integer hours for business-hours (see scoring.ts), string
 * `defaultFormat`, string `videoProvider`, integer `defaultDuration`,
 * integer `bufferMinutes`. Values are chosen per John's seed-and-show
 * pass: 9am–5pm, Google Meet, 30-minute meetings, no buffer.
 *
 * `activeCalendarIds: ["primary"]` (added 2026-04-26): a brand-new user's
 * connected Google account often surfaces 5+ calendars (work, personal,
 * holidays, family, subscribed feeds). Reading all of them at once leaks
 * irrelevant busy-time into availability scoring. Seeding the filter to
 * just the primary calendar — Google's canonical alias for the calendar
 * tied to the signing-in email — gets new users to a working "this is
 * MY calendar" mental model. Users broaden via the picker in the
 * availability panel; `activeCalendarIds` is honored by sync, scoring,
 * and live reads (see `src/lib/calendar.ts:251/464/544`,
 * `src/lib/scoring.ts:161`). Existing users without the field continue
 * to read all calendars — no migration; the change applies to fresh
 * sign-ups only.
 */
export function buildSeededExplicit(
  opts: { timezone?: string } = {},
): Record<string, unknown> {
  const seeded: Record<string, unknown> = {
    businessHoursStart: 9,
    businessHoursEnd: 17,
    defaultFormat: "video",
    videoProvider: "google_meet",
    defaultDuration: 30,
    bufferMinutes: 0,
    activeCalendarIds: ["primary"],
  };
  if (opts.timezone) seeded.timezone = opts.timezone;
  return seeded;
}
