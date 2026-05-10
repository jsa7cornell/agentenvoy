import type { TipTemplate } from "../types";
import { DEFAULT_TIP } from "../default-tip";

/**
 * Generative-fallback — last-resort template for non-anonymous links that
 * have no authored tip and no derived signals.
 *
 * Locked 2026-05-10 per John: this renders DEFAULT_TIP verbatim. The earlier
 * activity-substituting form ("Looking forward to coffee with John") was
 * dropped because it duplicates what's already shown in the card (title,
 * channel row). The tip should add personality, not restate facts.
 *
 * Source label: "From {host}" — same treatment as authored-link-tip's
 * fallback when the host hasn't customized.
 *
 * Anonymous links (`isAnonymousLink: true`) → this template doesn't apply,
 * `renderTip` returns null, no tip renders.
 */
export const generativeFallback: TipTemplate = {
  id: "generative-fallback-v1",
  sourceKind: "generative-fallback",
  sourceLabel: "From {host}",
  priority: 1,
  applies: (input) => !input.isAnonymousLink,
  render: () => DEFAULT_TIP,
};
