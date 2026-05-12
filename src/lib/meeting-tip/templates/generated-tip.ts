import type { TipTemplate } from "../types";

/**
 * Generated-tip — output of generateMeetingNotes (Haiku 4.5), persisted
 * on Link.parameters.generatedTip. Priority 9 sits BELOW authored-link-tip
 * (priority 11 = host pencil) so host-authored tips always win, but ABOVE
 * the derived-* and generative-fallback templates so the model-generated
 * tip is preferred over auto-derived heuristics when both are available.
 *
 * 2026-05-12 event-data-model-google-aligned-and-meeting-tip proposal (PR-2).
 *
 * Scaffolding-only in PR-2: the field reads cleanly, but no production
 * code populates `parameters.generatedTip` yet. The Haiku integration
 * (generateMeetingNotes) ships in a follow-up. Until then, this template
 * stays silent for all existing rows.
 */
export const generatedTip: TipTemplate = {
  id: "generated-tip-v1",
  sourceKind: "generative-author-time",
  sourceLabel: "Tip",
  priority: 9, // below authored-link-tip (11), above derived templates
  applies: (input) => !!input.linkGeneratedTip?.trim(),
  render: (input) => input.linkGeneratedTip!.trim(),
};
