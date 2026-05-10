import type { TipTemplate } from "../types";

/**
 * Authored-link-tip — the host's pencil-authored tip stored on
 * Link.parameters.tip. Highest priority (11) so it always wins when set.
 *
 * Per Phase 2 SEED design pivot 2026-05-10: this is the durable tip model.
 * Other templates (authored-day-of, derived-*, generative-fallback) are
 * either wrapped into this (as seed-time prompt input) or are fallback for
 * unauthored cases. PR2 introduces this template; the seed-generator that
 * pre-populates Link.parameters.tip at create-time is a follow-up sub-PR.
 */
export const authoredLinkTip: TipTemplate = {
  id: "authored-link-tip-v1",
  sourceKind: "authored-day-of", // reuse existing enum value; semantically "host-authored"
  sourceLabel: "Tip from {host}",
  priority: 11,
  applies: (input) => !!input.linkAuthoredTip?.trim(),
  render: (input) => input.linkAuthoredTip!.trim(),
};
