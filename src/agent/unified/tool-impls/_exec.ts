/**
 * Thin bridge from unified tool wrappers to the existing executeActions handler.
 *
 * Also runs the Layer 2 grounding check before executing any write action.
 * Advisory failures return an error string to the model (next step sees it).
 * Strict failures do the same but with a stronger message — the irreversible
 * nature means we prefer the model reconsider over silently proceeding.
 *
 * 2026-05-12: signature of the grounding check updated to take a
 * `GroundingCheckContext` (currentUserMessage + optional recentThread +
 * optional thisTurnToolResults). The runner builds the context per the
 * tool's declarations; this bridge passes it through.
 */
import { executeActions, type ActionResult } from "@/agent/actions";
import {
  runGroundingCheck,
  type GroundingCheckContext,
  type GroundingCheckResult,
  type LoadResultShape,
} from "../grounding-check";

/** Per-turn structured fire record (PR-D telemetry). */
export type GroundingFire = Extract<GroundingCheckResult, { ok: false }>["fires"][number];

export type ToolContext = {
  userId: string;
  sessionId?: string;
  meetSlug?: string;
  /** Current user message — passed to the grounding check. */
  userMessage?: string;
  /**
   * 2-turn preload (host + envoy). Populated by the runner when the active
   * tool has any `recentThread`-scoped declared field. Undefined when the
   * staleness trim fired (>10min gap) or when the runner didn't load history.
   */
  recentThread?: {
    priorUserTurn?: string;
    priorEnvoyTurn?: string;
  };
  /**
   * Read-only accessor for this-turn's tool results, accumulated by the
   * runner as the model emits LOAD calls before the write call. The runner
   * threads the accumulator's getter in via this field; LOAD tool-impls call
   * `recordToolResult` (sibling field, populated by the runner) to push
   * onto the same backing array.
   */
  getThisTurnToolResults?: () => ReadonlyArray<LoadResultShape>;
  /**
   * Callback for LOAD tool-impls to record their results into the per-turn
   * accumulator. Set by the runner alongside `getThisTurnToolResults`.
   */
  recordToolResult?: (toolName: string, result: unknown) => void;
  /**
   * Callback to record a grounding-check fire into the per-turn telemetry
   * accumulator. Set by the runner; consumed when building unifiedTurn
   * metadata (PR-D).
   */
  recordGroundingFire?: (fire: GroundingFire) => void;
};

export async function execAction(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  toolName?: string,
): Promise<ActionResult> {
  // Layer 2 grounding check — runs before the action handler.
  if (toolName && ctx.userMessage) {
    const groundingContext: GroundingCheckContext = {
      currentUserMessage: ctx.userMessage,
      recentThread: ctx.recentThread,
      thisTurnToolResults: ctx.getThisTurnToolResults?.(),
    };
    const check = runGroundingCheck(toolName, params, groundingContext);
    if (!check.ok) {
      // Push structured fires to per-turn telemetry accumulator (PR-D).
      // The runner reads from this accumulator when building unifiedTurn metadata.
      if (ctx.recordGroundingFire) {
        for (const fire of check.fires) {
          ctx.recordGroundingFire(fire);
        }
      }
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
    {
      sessionId: ctx.sessionId,
      meetSlug: ctx.meetSlug,
      // 2026-05-12 event-data-model proposal (PR-2c): thread the current user
      // message down so handleCreateLink can persist it on
      // NegotiationLink.creationPrompt. Used by regenerateMeetingNotesForLink
      // on activity/time/invitee edit triggers.
      userMessage: ctx.userMessage,
    },
  );
  return results[0] ?? { success: false, message: "No result returned" };
}
