import type { TipTemplate } from "../types";

export const derivedRelationshipHistory: TipTemplate = {
  id: "derived-relationship-history-v1",
  sourceKind: "derived-relationship-history",
  sourceLabel: "From your last meeting",
  priority: 6,
  applies: (input) => input.hasPriorSessions && !input.isAnonymousLink,
  render: (input, viewerRole) => {
    const other = viewerRole === "guest" ? input.hostFirstName : input.guestFirstName;
    return `You last met ${other} a few sessions ago.`;
  },
};
