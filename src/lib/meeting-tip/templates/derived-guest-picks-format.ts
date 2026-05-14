import type { TipTemplate } from "../types";

/**
 * derived-guest-picks-format — fires when the host has deferred format
 * selection to the guest (`guestPicks.format: true`).
 *
 * Covers both the format-only case and the combined format+location case.
 * When location is also deferred, the tip folds both deferrals into one
 * sentence so the guest gets a single, coherent prompt.
 *
 * Priority 6 — sits above derived-guest-picks-location (5) so that when
 * both format and location are deferred, this template fires first and
 * handles both. The location template fires independently only when format
 * is already locked to in-person (its `applies` guard is unchanged).
 */
export const derivedGuestPicksFormat: TipTemplate = {
  id: "derived-guest-picks-format-v1",
  sourceKind: "derived-guest-picks-format",
  sourceLabel: "From {host}",
  priority: 6,
  applies: (input) => !!input.guestPicksFormat && !input.isAnonymousLink,
  render: (input, viewerRole) => {
    const alsoLocation = !!input.guestPicksLocation;
    if (viewerRole === "host") {
      if (alsoLocation) {
        return `${input.guestFirstName} picks the format and spot — they'll confirm in chat or on the form.`;
      }
      return `${input.guestFirstName} picks the format — they'll confirm video, phone, or in-person.`;
    }
    // Guest view
    if (alsoLocation) {
      return `${input.hostFirstName}'d love your call on the format and where to meet — let me know in chat or add it below.`;
    }
    return `${input.hostFirstName}'d love your call on the format — video, phone, or in-person?`;
  },
};
