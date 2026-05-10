import type { TipTemplate } from "../types";

export const generativeFallback: TipTemplate = {
  id: "generative-fallback-v1",
  sourceKind: "generative-fallback",
  sourceLabel: "Generated for you",
  priority: 1,
  applies: (input) => !input.isAnonymousLink,
  render: (input, viewerRole) => {
    const other = viewerRole === "guest" ? input.hostFirstName : input.guestFirstName;
    if (input.linkActivity) {
      return `Looking forward to ${input.linkActivity} with ${other}.`;
    }
    return `Looking forward to meeting with ${other}.`;
  },
};
