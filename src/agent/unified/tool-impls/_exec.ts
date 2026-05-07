/**
 * Thin bridge from unified tool wrappers to the existing executeActions handler.
 * Keeps write tools as single-action calls so each tool is independently
 * validated, logged, and grounding-checked.
 */
import { executeActions, type ActionResult } from "@/agent/actions";

export type ToolContext = {
  userId: string;
  sessionId?: string;
  meetSlug?: string;
};

export async function execAction(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ActionResult> {
  const results = await executeActions(
    [{ action, params }],
    ctx.userId,
    { sessionId: ctx.sessionId, meetSlug: ctx.meetSlug },
  );
  return results[0] ?? { success: false, message: "No result returned" };
}
