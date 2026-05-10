import type { TipTemplate } from "../types";

export const derivedSeriesProgress: TipTemplate = {
  id: "derived-series-progress-v1",
  sourceKind: "derived-series-progress",
  sourceLabel: "Series tip",
  priority: 5,
  applies: (input) =>
    input.isRecurring &&
    typeof input.recurringPosition === "number" &&
    typeof input.recurringTotal === "number",
  render: (input) =>
    `Session ${input.recurringPosition} of ${input.recurringTotal} — keep up the rhythm.`,
};
