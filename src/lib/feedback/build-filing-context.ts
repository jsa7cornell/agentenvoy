/**
 * filingContext builder (T2c of proposals/2026-04-21).
 *
 * Deterministic, no LLM. Given a chronologically-ordered message list and
 * a `filedAt` timestamp, compute the digest the agent reads first:
 *
 *   suspectedIncidentTurn — ordered heuristic:
 *     (1) most recent agent turn whose actionResults contains a failure;
 *     (2) else, most recent user→agent turn within 10 min of `filedAt`;
 *     (3) else, the last agent turn before `filedAt`.
 *
 *   recentFailures — every failed ActionResult in the window, newest-first.
 *
 *   lastAgentOutcome — "success" / "error" / "action_failed" / "no_action"
 *     summarising the most recent agent turn.
 *
 * Input messages must already be sorted oldest→newest.
 */

import {
  parseChannelMessageMetadata,
  type ActionCall,
  type ActionResultRecord,
} from "@/lib/channel/metadata-schema";
import type { FilingContext } from "@/lib/feedback/schema";

export interface FilingMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
  metadata: unknown;
}

const AGENT_ROLES = new Set([
  "envoy",
  "administrator",
  "assistant",
  "host_note",
]);
const USER_ROLES = new Set(["user", "host", "guest"]);
const RECENT_WINDOW_MS = 10 * 60 * 1000;

function isAgentRole(role: string): boolean {
  return AGENT_ROLES.has(role);
}

function isUserRole(role: string): boolean {
  return USER_ROLES.has(role);
}

function parseActions(meta: ReturnType<typeof parseChannelMessageMetadata>): ActionCall[] {
  return meta.actions ?? [];
}

function parseResults(meta: ReturnType<typeof parseChannelMessageMetadata>): ActionResultRecord[] {
  return meta.actionResults ?? [];
}

function hasFailure(results: ActionResultRecord[]): boolean {
  return results.some((r) => !r.success);
}

function previousUserMsg(messages: FilingMessage[], agentIdx: number): FilingMessage | null {
  for (let i = agentIdx - 1; i >= 0; i--) {
    if (isUserRole(messages[i].role)) return messages[i];
  }
  return null;
}

function describeTime(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  if (ms < 0) return "in the future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function buildFilingContext(
  messages: FilingMessage[],
  filedAt: Date,
): FilingContext {
  // Parse metadata once per message.
  const enriched = messages.map((m) => {
    const meta = parseChannelMessageMetadata(m.metadata);
    return {
      ...m,
      parsedActions: parseActions(meta),
      parsedResults: parseResults(meta),
    };
  });

  const lastAgentIdx = findLastIndex(enriched, (m) => isAgentRole(m.role));
  const lastAgent = lastAgentIdx >= 0 ? enriched[lastAgentIdx] : null;
  const lastUser = findLast(enriched, (m) => isUserRole(m.role));

  const lastAgentOutcome: FilingContext["lastAgentOutcome"] = (() => {
    if (!lastAgent) return "no_action";
    if (lastAgent.parsedResults.length === 0) {
      return lastAgent.parsedActions.length === 0 ? "no_action" : "success";
    }
    return hasFailure(lastAgent.parsedResults) ? "action_failed" : "success";
  })();

  // Heuristic step 1: most recent agent turn with a failed ActionResult.
  let incidentIdx = findLastIndex(enriched, (m) =>
    isAgentRole(m.role) && hasFailure(m.parsedResults),
  );

  // Step 2: most recent user→agent within 10 min of filedAt.
  if (incidentIdx < 0) {
    const cutoff = filedAt.getTime() - RECENT_WINDOW_MS;
    incidentIdx = findLastIndex(enriched, (m) => {
      if (!isAgentRole(m.role)) return false;
      if (m.createdAt.getTime() < cutoff) return false;
      return true;
    });
  }

  // Step 3: last agent turn before filedAt.
  if (incidentIdx < 0) {
    incidentIdx = lastAgentIdx;
  }

  const suspectedIncidentTurn = (() => {
    if (incidentIdx < 0) return null;
    const agentMsg = enriched[incidentIdx];
    const userMsg = previousUserMsg(enriched, incidentIdx);
    const outcome = hasFailure(agentMsg.parsedResults)
      ? "action_failed"
      : agentMsg.parsedResults.length > 0
        ? "success"
        : agentMsg.parsedActions.length === 0
          ? "no_action"
          : "success";
    return {
      messageId: agentMsg.id,
      outcome,
      userMsg: userMsg
        ? {
            id: userMsg.id,
            content: userMsg.content,
            createdAt: userMsg.createdAt.toISOString(),
          }
        : null,
      agentMsg: {
        id: agentMsg.id,
        content: agentMsg.content,
        createdAt: agentMsg.createdAt.toISOString(),
        ...(agentMsg.parsedActions.length > 0
          ? {
              actions: agentMsg.parsedActions.map((a) => ({
                action: a.action,
                params: a.params,
              })),
            }
          : {}),
        ...(agentMsg.parsedResults.length > 0
          ? {
              actionResults: agentMsg.parsedResults.map((r) => ({
                action: r.action,
                success: r.success,
                message: r.message,
                ...(r.data ? { data: r.data } : {}),
              })),
            }
          : {}),
      },
    };
  })();

  const recentFailures: FilingContext["recentFailures"] = [];
  for (let i = enriched.length - 1; i >= 0 && recentFailures.length < 20; i--) {
    const m = enriched[i];
    if (!isAgentRole(m.role)) continue;
    for (const r of m.parsedResults) {
      if (r.success) continue;
      recentFailures.push({
        messageId: m.id,
        action: r.action,
        failureReason: r.message,
        at: m.createdAt.toISOString(),
      });
    }
  }

  return {
    filedAt: filedAt.toISOString(),
    timeSinceLastUserMsg: lastUser ? describeTime(lastUser.createdAt, filedAt) : null,
    lastAgentOutcome,
    suspectedIncidentTurn,
    recentFailures,
  };
}

/** Returns the number of recent turns to emit — at least 10, extended to
 *  cover the suspected incident turn when it falls outside the last 10. */
export function computeRecentTurnsCount(
  totalMessages: number,
  incidentMessageId: string | null,
  orderedMessages: FilingMessage[],
  baseline = 10,
): number {
  if (!incidentMessageId) return Math.min(baseline, totalMessages);
  const idx = orderedMessages.findIndex((m) => m.id === incidentMessageId);
  if (idx < 0) return Math.min(baseline, totalMessages);
  const distanceFromEnd = totalMessages - idx;
  return Math.max(baseline, distanceFromEnd);
}

function findLast<T>(arr: T[], pred: (t: T) => boolean): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i];
  }
  return null;
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}
