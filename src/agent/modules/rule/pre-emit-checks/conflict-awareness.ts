/**
 * `conflictAwarenessGuard` — deterministic preEmitCheck.
 *
 * The conflict-awareness gap John surfaced 2026-05-04: rule-tier emissions
 * of `block` / `location` / `no_in_person` would silently shadow existing
 * meetings without this check. The composer is taught (via the playbook)
 * to call `check_conflicts_for_rule` first and narrate any shadow count;
 * THIS guard is the deterministic guarantee that fires regardless of
 * whether the composer used the tool.
 *
 * Severity: blocking — if the composer emits a shadowing rule and retries
 * fail to either narrate the shadow OR proceed with explicit acknowledgment,
 * ship fallbackProse and skip the rule write entirely.
 */
import type { PreEmitCheck } from "@/agent/modules/types";
import type { RuleContext } from "../context-loader";

const SHADOWING_ACTIONS = new Set(["block", "location", "no_in_person"]);

/** Names of phrases the composer's prose should contain if it has acknowledged shadow. */
const ACKNOWLEDGMENT_PATTERNS: RegExp[] = [
  /\bshadow(?:s|ed|ing)?\b/i,
  /\bconflict(?:s|ed|ing)?\b/i,
  /\bblocks?\s+\d+\b/i,
  /\bclash(?:es|ed|ing)?\b/i,
  /\boverlap(?:s|ped|ping)?\b/i,
  /\bexisting\s+meeting/i,
  /\bconfirmed\s+meeting/i,
];

export const conflictAwarenessGuard: PreEmitCheck<RuleContext> = {
  name: "conflict-awareness-guard",
  severity: "blocking",
  check: async ({ parsedActions, contextOutput }) => {
    for (const action of parsedActions) {
      if (action.action !== "update_availability_rule") continue;
      const params = action.params as {
        operation?: string;
        rule?: { action?: string; daysOfWeek?: number[]; timeStart?: string; timeEnd?: string; effectiveDate?: string; expiryDate?: string };
      };

      // Only `add` and `update` of shadowing actions need the check.
      if (params.operation !== "add" && params.operation !== "update") continue;
      if (!params.rule || !params.rule.action) continue;
      if (!SHADOWING_ACTIONS.has(params.rule.action)) continue;

      const shadowed = countShadowedEvents(contextOutput.upcomingEvents ?? [], params.rule);
      if (shadowed.length === 0) continue;

      return {
        flaggedReason: "rule-conflict-shadow",
        hint: `The rule you emitted (${params.rule.action} ${formatRuleWindow(params.rule)}) would shadow ${shadowed.length} confirmed meeting${shadowed.length === 1 ? "" : "s"}: ${shadowed.slice(0, 3).map((e) => e.summary).join(", ")}${shadowed.length > 3 ? ", ..." : ""}.\n\nIf the host has explicitly acknowledged this shadow in the most recent message (e.g., they said "yes, do it anyway" after seeing the conflicts), narrate the shadow count in your response and proceed with the same emission.\n\nIf they haven't yet acknowledged, do NOT emit the rule. Instead, narrate the conflict and ask: "I see this would shadow ${shadowed.length} confirmed Tuesday 2pm meetings — still want to proceed?" Wait for the host's explicit confirmation before emitting.`,
        fallbackProse: `I noticed this rule would shadow ${shadowed.length} confirmed meeting${shadowed.length === 1 ? "" : "s"} on your calendar. Could you confirm you want to proceed, or would you prefer a different shape?`,
      };
    }
    return null;
  },
};

interface UpcomingEvent {
  summary: string;
  startIso: string;
  endIso: string;
}

function countShadowedEvents(
  events: readonly UpcomingEvent[],
  rule: { daysOfWeek?: number[]; timeStart?: string; timeEnd?: string; effectiveDate?: string; expiryDate?: string },
): UpcomingEvent[] {
  const out: UpcomingEvent[] = [];
  for (const ev of events) {
    const start = new Date(ev.startIso);
    if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
      if (!rule.daysOfWeek.includes(start.getDay())) continue;
    }
    if (rule.timeStart && rule.timeEnd) {
      const hm = `${start.getHours().toString().padStart(2, "0")}:${start.getMinutes().toString().padStart(2, "0")}`;
      if (hm < rule.timeStart || hm >= rule.timeEnd) continue;
    }
    if (rule.effectiveDate && start < new Date(rule.effectiveDate)) continue;
    if (rule.expiryDate && start > new Date(rule.expiryDate)) continue;
    out.push(ev);
  }
  return out;
}

function formatRuleWindow(rule: { daysOfWeek?: number[]; timeStart?: string; timeEnd?: string }): string {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = rule.daysOfWeek?.map((d) => dayNames[d]).join("+") ?? "all days";
  const time = rule.timeStart && rule.timeEnd ? ` ${rule.timeStart}-${rule.timeEnd}` : "";
  return `${days}${time}`;
}

// Note: ACKNOWLEDGMENT_PATTERNS exported for future "smart bypass" — if the
// composer's prose already acknowledges the shadow (e.g., F14 fixture #4 with
// host saying "yes, block it anyway"), we could relax the guard. Spike doesn't
// implement this; keeps the test deterministic.
export const _ACKNOWLEDGMENT_PATTERNS_FOR_FUTURE = ACKNOWLEDGMENT_PATTERNS;
