import type { TipTemplate } from "../types";

export const authoredTravel: TipTemplate = {
  id: "authored-travel-v1",
  sourceKind: "authored-travel",
  sourceLabel: "Tip from {host}",
  priority: 9,
  applies: (input) => !!input.tipTravel?.trim(),
  render: (input) => input.tipTravel!.trim(),
};
