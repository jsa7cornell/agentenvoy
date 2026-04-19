/**
 * Deterministic failure-narration rewriter. When any action in a turn fails,
 * the LLM's drafted prose may already claim success (the model commits to a
 * story before it knows tool outcomes). We don't trust the LLM's voice on
 * failure — instead we fully replace its narration with a template keyed on
 * the action kind and result.
 *
 * Background: narration-hygiene-v2 proposal (decided 2026-04-20). Replaces
 * the prepend-only approach shipped in bcf2ec1 which left the LLM's misleading
 * success text visible below the ⚠️ warning.
 *
 * Called from channel/chat/route.ts AFTER executeActions completes and BEFORE
 * the turn is delivered to the client (always-buffer mode). The original LLM
 * draft is preserved in ChannelMessage.metadata.overriddenNarration for
 * debug/forensics — we want to know *what* the LLM drafted when it was
 * drafting confidently wrong prose.
 */

import type { ActionRequest, ActionResult } from "./actions";

export interface NarrationContext {
  /** Human-friendly name of the link/session being acted on, when known. */
  linkLabel?: string | null;
  /** Host's first name, for templates that reference them. */
  hostFirstName?: string | null;
  /** Guest's first name, for templates that reference them. */
  guestFirstName?: string | null;
}

/**
 * If ALL results succeeded, return the LLM's draft untouched.
 * If ANY result failed, emit a deterministic template that:
 *   - Names the action and the failure reason
 *   - Does NOT reuse the LLM's narration (it may have committed to success)
 *   - Preserves the list structure when multiple actions ran (mix of ✓ / ✗)
 */
export function narrateFailures(
  actions: ActionRequest[],
  results: ActionResult[],
  llmDraft: string,
  ctx: NarrationContext = {},
): string {
  const failed = results.filter((r) => !r.success);
  if (failed.length === 0) return llmDraft;

  // Single action failed — emit a single-line template.
  if (actions.length === 1 && results.length === 1 && !results[0].success) {
    return templateFor(actions[0], results[0], ctx);
  }

  // Multiple actions, mixed outcomes — bullet list with ✓/✗.
  const lines = actions.map((a, i) => {
    const r = results[i];
    if (!r) return `✗ ${a.action}: no result`;
    const mark = r.success ? "✓" : "✗";
    return `${mark} ${templateFor(a, r, ctx)}`;
  });
  return `⚠️ Some of that didn't go through:\n\n${lines.join("\n")}`;
}

function templateFor(
  action: ActionRequest,
  result: ActionResult,
  ctx: NarrationContext,
): string {
  if (result.success) return result.message;

  const reason = result.message || "unknown error";
  const label = ctx.linkLabel ? ` "${ctx.linkLabel}"` : "";

  switch (action.action) {
    case "update_link":
    case "expand_link":
      if (/link not found/i.test(reason)) {
        return `⚠️ Couldn't update the link${label} — I may have grabbed the wrong one. Can you tell me which meeting you meant?`;
      }
      return `⚠️ Couldn't update the link${label}: ${reason}.`;
    case "create_link":
      return `⚠️ Couldn't create the link: ${reason}.`;
    case "cancel":
      return `⚠️ Couldn't cancel${label}: ${reason}.`;
    case "archive":
    case "archive_bulk":
      return `⚠️ Couldn't archive${label}: ${reason}.`;
    case "hold":
      return `⚠️ Couldn't place a hold${label}: ${reason}.`;
    case "save_guest_info":
      return `⚠️ Couldn't save guest info: ${reason}.`;
    default:
      return `⚠️ That didn't go through: ${reason}.`;
  }
}

/**
 * Template used when executeActions wraps in a timeout and times out mid-flight.
 * Deterministic line; the actual action may still be running in the background.
 * Kept separate from narrateFailures because the action hasn't "failed" — it's
 * still pending — so we don't want to claim it didn't work.
 */
export function narrateTimeout(): string {
  return `⏳ Still working on that — I'll confirm in a moment.`;
}

/**
 * Template used when finalizeResponse itself throws AFTER the LLM produced
 * text. Last-resort deterministic line before we close the stream. Never let
 * a raw 500 / controller.error propagate to the client when we have something
 * better to say.
 */
export function narrateFinalizeError(): string {
  return `⚠️ Something went wrong wrapping that up. Try again, or reach out if it keeps happening.`;
}
