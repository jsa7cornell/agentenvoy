import type { TipTemplate } from "../types";

export const derivedCalendarOverlap: TipTemplate = {
  id: "derived-calendar-overlap-v1",
  sourceKind: "derived-calendar-overlap",
  sourceLabel: "Based on your calendars",
  priority: 7,
  applies: (input) => !!input.bothCalendarsConnected && !input.isAnonymousLink,
  render: (input, viewerRole) => {
    const other = viewerRole === "guest" ? input.hostFirstName : input.guestFirstName;
    return `You and ${other} both have this slot open.`;
  },
};
