/**
 * `check_conflicts_for_rule` — composer-callable tool.
 *
 * The rule module's tool for state-grounding rule emissions against the
 * host's calendar. Per F14/F15 family + the conflict-awareness gap John
 * surfaced 2026-05-04: rule-tier emissions of `block` / `location` /
 * `no_in_person` would silently shadow existing meetings without this
 * check. The composer is taught (via the playbook) to call this tool
 * before emitting any of those rule sub-actions.
 *
 * Spike note: tool surface only; the actual check vs the host's calendar
 * is mocked in fixtures (the contextLoader pre-loads `upcomingEvents`
 * and the tool reads from there). Productionized version (PR1c) reads
 * directly from `getOrComputeSchedule(userId)`.
 */
import { z } from "zod";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { CalendarEvent } from "@/lib/calendar";
import type { ComposerTool, ModuleContext } from "@/agent/modules/types";

const inputSchema = z.object({
  rule: z.object({
    action: z
      .enum(["block", "location", "no_in_person", "buffer", "limit", "prefer", "allow", "bookable"])
      .describe("The rule sub-action being proposed."),
    type: z
      .enum(["ongoing", "recurring", "temporary", "one-time"])
      .describe("Rule scope/duration."),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    timeStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    timeEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).strict(),
});

export type CheckConflictsForRuleInput = z.infer<typeof inputSchema>;

export interface CheckConflictsForRuleOutput {
  /** Total number of upcoming events the rule would shadow. */
  shadowedCount: number;
  /** First few shadowed events for narration. */
  shadowed: Array<{
    summary: string;
    startIso: string;
    endIso: string;
  }>;
  /** Rule sub-actions that DO shadow: block, location, no_in_person. Others (allow, prefer, etc.) return shadowedCount: 0. */
  shadowing: boolean;
  /** Sub-actions like `bookable` don't shadow at all — they coexist with calendar. */
  message: string;
}

const TOOL_DESCRIPTION = `Check whether a proposed availability rule would shadow ("conflict with") any of the host's existing confirmed meetings. Use this BEFORE emitting any \`update_availability_rule\` action with rule.action of \`block\`, \`location\`, or \`no_in_person\` — these sub-actions can silently make existing meetings invisible to the system.

When to call:
- ANY \`block\` rule (recurring, temporary, ongoing, one-time)
- ANY \`location\` rule (forces all meetings to a venue — could be wrong for some)
- ANY \`no_in_person\` rule (forces video — could conflict with confirmed in-person meetings)

When NOT to call:
- \`bookable\` rules (these add availability, they don't subtract)
- \`allow\` / \`prefer\` rules (decoration; don't filter)
- \`buffer\` / \`limit\` rules (time-shape adjustments; not meeting-shadow)

Returns: \`shadowedCount\` (number of confirmed meetings that fall in the rule's window), \`shadowed\` (first few — name + start/end), and \`shadowing\` (boolean: does this rule sub-action even shadow conceptually).

If \`shadowedCount > 0\`, narrate the shadow count to the host BEFORE emitting the action: "I see this would block 8 confirmed Tuesday 2pm meetings — still want to proceed?" If they confirm, then emit. If they don't, ask what they'd prefer.

If \`shadowing: false\` (e.g., bookable rule), don't bother narrating; the rule doesn't shadow anyone.`;

/**
 * Build the tool. The tool reads from ModuleContext via the rule module's
 * contextLoader output (`upcomingEvents` field) — the spike approach. PR1c
 * generalizes to direct calendar fetch.
 */
export const checkConflictsForRule: ComposerTool<
  CheckConflictsForRuleInput,
  CheckConflictsForRuleOutput
> = {
  name: "check_conflicts_for_rule",
  description: TOOL_DESCRIPTION,
  inputSchema,
  execute: async (input, ctx) => {
    // Test seam: bench fixtures inject `__testUpcomingEvents` on ModuleContext.
    // Production: pull from the rule module's contextLoader output (which loaded
    // upcoming events once at the top of the turn from `getOrComputeSchedule`).
    // The tool re-uses that same data via the test seam — production callers
    // never set `__testUpcomingEvents`, so the tool falls through to a fresh
    // schedule load below.
    const seam = ctx as ModuleContext & { __testUpcomingEvents?: Array<{ summary: string; startIso: string; endIso: string }> };
    let upcomingEvents: Array<{ summary: string; startIso: string; endIso: string }> = seam.__testUpcomingEvents ?? [];
    if (!seam.__testUpcomingEvents) {
      try {
        const schedule = await getOrComputeSchedule(ctx.user.id);
        const now = Date.now();
        const horizon = now + 60 * 24 * 60 * 60 * 1000;
        upcomingEvents = (schedule?.events ?? [])
          .filter((ev: CalendarEvent) => {
            const start = ev.start instanceof Date ? ev.start.getTime() : new Date(ev.start).getTime();
            return start >= now && start <= horizon;
          })
          .slice(0, 100)
          .map((ev: CalendarEvent) => ({
            summary: ev.summary ?? "(busy)",
            startIso: ev.start instanceof Date ? ev.start.toISOString() : String(ev.start),
            endIso: ev.end instanceof Date ? ev.end.toISOString() : String(ev.end ?? ev.start),
          }));
      } catch (e) {
        console.warn(`[check_conflicts_for_rule] schedule load failed:`, e);
        upcomingEvents = [];
      }
    }

    const SHADOWING_ACTIONS = new Set(["block", "location", "no_in_person"]);
    const shadowing = SHADOWING_ACTIONS.has(input.rule.action);

    if (!shadowing) {
      return {
        shadowedCount: 0,
        shadowed: [],
        shadowing: false,
        message: `Rule action "${input.rule.action}" doesn't shadow existing meetings.`,
      };
    }

    // Compute shadow set. Spike: iterate upcomingEvents; check overlap with rule window.
    const matched: typeof upcomingEvents = [];
    for (const event of upcomingEvents) {
      if (eventMatchesRule(event, input.rule)) matched.push(event);
    }

    return {
      shadowedCount: matched.length,
      shadowed: matched.slice(0, 5),
      shadowing: true,
      message:
        matched.length === 0
          ? "No confirmed meetings would be shadowed by this rule."
          : `This rule would shadow ${matched.length} confirmed meeting${matched.length === 1 ? "" : "s"}.`,
    };
  },
};

function eventMatchesRule(
  event: { summary: string; startIso: string; endIso: string },
  rule: CheckConflictsForRuleInput["rule"],
): boolean {
  const start = new Date(event.startIso);
  // Match day-of-week if specified
  if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
    if (!rule.daysOfWeek.includes(start.getDay())) return false;
  }
  // Match time window if specified
  if (rule.timeStart && rule.timeEnd) {
    const eventHM = `${start.getHours().toString().padStart(2, "0")}:${start
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
    if (eventHM < rule.timeStart || eventHM >= rule.timeEnd) return false;
  }
  // Match date range if specified
  if (rule.effectiveDate) {
    const effDate = new Date(rule.effectiveDate);
    if (start < effDate) return false;
  }
  if (rule.expiryDate) {
    const expDate = new Date(rule.expiryDate);
    if (start > expDate) return false;
  }
  return true;
}
