import type { TipTemplate } from "../types";

/**
 * derived-guest-picks-location — fires on in-person links where the host
 * deferred venue selection to the guest (`guestPicks.location: true`).
 *
 * Surfaces the deferral in the tip slot so the card header stays clean —
 * the page reads "TBD" for location, the tip explains *why* and prompts
 * the guest to fill it in (either via the confirm form's location input
 * or in chat with Envoy).
 *
 * Priority 5 — sits above generative-fallback (1) but below all authored
 * templates (10–40), so a host-authored tip still wins.
 */
export const derivedGuestPicksLocation: TipTemplate = {
  id: "derived-guest-picks-location-v1",
  sourceKind: "derived-guest-picks-location",
  sourceLabel: "From {host}",
  priority: 5,
  applies: (input) =>
    !!input.guestPicksLocation &&
    input.meetingFormat === "in-person" &&
    !input.isAnonymousLink,
  render: (input, viewerRole) => {
    if (viewerRole === "host") {
      return `${input.guestFirstName} picks the spot — they'll drop it on the confirm form or in chat.`;
    }
    return `${input.hostFirstName}'d love your call on where to meet — add it below or tell me in chat.`;
  },
};
