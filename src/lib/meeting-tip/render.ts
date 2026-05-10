/**
 * renderTip — single source of truth for tip rendering.
 *
 * AP5b parity invariant (binding, see proposal § 6.3):
 * Both deal-room renderer and future MCP get_tip handler MUST call this
 * function. templateId and sourceKind are role-invariant; only `text`
 * may differ by viewer-role pronoun resolution.
 */

import type { TipInput, RenderedTip, ViewerRole } from "./types";
import { selectTip } from "./registry";

export function renderTip(
  input: TipInput,
  viewerRole: ViewerRole
): RenderedTip | null {
  const template = selectTip(input);
  if (!template) return null;
  return {
    text: template.render(input, viewerRole),
    source: template.sourceLabel.replace("{host}", input.hostFirstName),
    sourceKind: template.sourceKind,
    templateId: template.id,
    generatedAt: new Date().toISOString(),
  };
}
