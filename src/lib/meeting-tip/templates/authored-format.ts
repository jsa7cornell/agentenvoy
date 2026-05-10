import type { TipTemplate } from "../types";

export const authoredFormat: TipTemplate = {
  id: "authored-format-v1",
  sourceKind: "authored-format",
  sourceLabel: "From {host}",
  priority: 8,
  applies: (input) => !!input.tipFormat?.trim(),
  render: (input) => input.tipFormat!.trim(),
};
