import type { TipTemplate } from "../types";

export const authoredDayOf: TipTemplate = {
  id: "authored-day-of-v1",
  sourceKind: "authored-day-of",
  sourceLabel: "Day-of tip from {host}",
  priority: 10,
  applies: (input) => !!input.tipDayOf?.trim(),
  render: (input) => input.tipDayOf!.trim(),
};
