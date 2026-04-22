/**
 * Seed defaults for a newly created user. See proposal
 * `2026-04-21_lean-first-run-onboarding-and-returnto_*.md` §2.7.
 *
 * Written from `events.createUser` so a fresh user lands with sensible
 * defaults already set. The `defaults_confirm` onboarding phase then shows
 * the user what was seeded and asks for a single confirmation — "Looks
 * good" or "Change these". Replaces the old 4-phase ask-each-field flow.
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
  };
  if (opts.timezone) seeded.timezone = opts.timezone;
  return seeded;
}
