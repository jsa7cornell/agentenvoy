/**
 * Thin bridge from unified tool wrappers to the existing executeActions handler.
 *
 * Also runs the Layer 2 grounding check before executing any write action.
 * Advisory failures return an error string to the model (next step sees it).
 * Strict failures do the same but with a stronger message — the irreversible
 * nature means we prefer the model reconsider over silently proceeding.
 */
import { executeActions, type ActionResult } from "@/agent/actions";
import { runGroundingCheck } from "../grounding-check";

export type ToolContext = {
  userId: string;
  sessionId?: string;
  meetSlug?: string;
  /** Current user message — passed to the grounding check. */
  userMessage?: string;
};

export async function execAction(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  toolName?: string,
): Promise<ActionResult> {
  // Layer 2 grounding check — runs before the action handler.
  if (toolName && ctx.userMessage) {
    const check = runGroundingCheck(toolName, params, ctx.userMessage);
    if (!check.ok) {
      // Return the grounding error as a tool result so the model can retry.
      // The SDK feeds this back as the tool-result content in the next step.
      return {
        success: false,
        message: check.error,
      };
    }
  }

  const results = await executeActions(
    [{ action, params }],
    ctx.userId,
    { sessionId: ctx.sessionId, meetSlug: ctx.meetSlug },
  );
  return results[0] ?? { success: false, message: "No result returned" };
}
