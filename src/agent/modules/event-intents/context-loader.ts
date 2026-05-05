/**
 * Event-intent context loader — wraps the shared schedule-context loader and
 * folds the matcher's deterministic-create hint into `systemPromptSuffix`.
 *
 * The hint is built at the route layer by `buildDeterministicCreateHint` and
 * passed through `matchResult.resolved.args.precheckHint`. PR3b-iii preserves
 * the legacy schedule path's `system = systemBase + precheckHintBlock + ...`
 * shape — the hint sits between the playbook fragments and the # Context
 * block, exactly where the legacy `precheckHintBlock` lived.
 */
import {
  loadScheduleContext,
  type ScheduleContext,
} from "@/agent/modules/_shared/schedule-context";
import type {
  ModuleContext,
  MatchResult,
} from "@/agent/modules/types";

export async function loadEventIntentContext(
  moduleContext: ModuleContext,
  matchResult: MatchResult,
  userMessage: string,
): Promise<ScheduleContext> {
  const base = await loadScheduleContext(moduleContext, matchResult, userMessage);
  if (matchResult.kind !== "deterministic") return base;
  const args = matchResult.resolved.args as
    | { precheckHint?: unknown }
    | undefined;
  if (typeof args?.precheckHint === "string" && args.precheckHint.trim()) {
    return { ...base, systemPromptSuffix: args.precheckHint };
  }
  return base;
}
