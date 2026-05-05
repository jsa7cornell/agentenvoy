/**
 * Rule module context loader — production wiring.
 *
 * Loads the state the rule composer needs:
 *  - `recentRules`: the host's existing rules (id + summary), formatted as
 *    [GROUND TRUTH] CURRENT RULES block (F14 Phase 3.A)
 *  - `upcomingEvents`: calendar events in the foreseeable window, used by
 *    `conflictAwarenessGuard` and the `check_conflicts_for_rule` tool
 *  - `primaryLinkDefaults`: the host's default format/duration/hours
 *
 * Test seam: `__testRuleContext` field on `ModuleContext` allows tests + bench
 * fixtures to inject pre-loaded data, bypassing prisma + getOrComputeSchedule.
 * Production code paths NEVER set this field; tests do for deterministic runs.
 */
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { ModuleContext, ModuleContextOutput, MatchResult } from "@/agent/modules/types";

export interface RuleSummary {
  id: string;                                   // rule_xxx (real cuid) or stable test id
  name: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: string;                               // bookable, block, location, ...
  daysOfWeek?: number[];
  timeStart?: string;
  timeEnd?: string;
  effectiveDate?: string;
  expiryDate?: string;
}

export interface UpcomingEvent {
  summary: string;
  startIso: string;
  endIso: string;
}

export interface RuleContext extends ModuleContextOutput {
  recentRules: RuleSummary[];
  upcomingEvents: UpcomingEvent[];
  primaryLinkDefaults: { format: string; duration: number; hours: string };
}

/**
 * Test-seam fields on ModuleContext. Tests and bench fixtures inject these to
 * skip prisma + getOrComputeSchedule. Production callers NEVER set them.
 *
 * Named `__test*` (not `__spike*`) since this is production code that supports
 * test-time injection per the proposal's "testability is the lever" principle.
 */
export interface RuleContextTestInjection {
  __testRecentRules?: RuleSummary[];
  __testUpcomingEvents?: UpcomingEvent[];
  __testPrimaryDefaults?: { format: string; duration: number; hours: string };
}

/**
 * Render the [GROUND TRUTH] CURRENT RULES block — F14 Phase 3.A in production form.
 * The block lives at the top of the CONTEXT section; the composer reads ids from it.
 */
export function renderCurrentRulesBlock(rules: readonly RuleSummary[]): string {
  if (rules.length === 0) {
    return [
      "[GROUND TRUTH] CURRENT RULES",
      "The host has no availability rules right now.",
      "Use operation:\"add\" to create a new rule. Never fabricate an id.",
    ].join("\n");
  }
  const lines: string[] = [];
  lines.push("[GROUND TRUTH] CURRENT RULES");
  lines.push("The host has these availability rules right now. Use these ids verbatim for");
  lines.push("update/remove operations. Never fabricate an id.");
  lines.push("");
  lines.push("| id | name | type | action | days | hours |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rules) {
    const days = r.daysOfWeek?.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join("+") ?? "—";
    const hours = r.timeStart && r.timeEnd ? `${r.timeStart}-${r.timeEnd}` : "—";
    lines.push(`| \`${r.id}\` | ${r.name} | ${r.type} | ${r.action} | ${days} | ${hours} |`);
  }
  return lines.join("\n");
}

const UPCOMING_DAYS_WINDOW = 60;                 // look ahead 2 months for conflict-awareness

/**
 * Production loader. Reads from prisma + getOrComputeSchedule. Tests + bench
 * fixtures override via `__test*` fields on ModuleContext.
 */
export async function loadRuleContext(
  moduleContext: ModuleContext,
  matchResult: MatchResult,
  userMessage: string,
): Promise<RuleContext> {
  // matchResult + userMessage reserved for future use (e.g., narrowing the
  // ground-truth block by matched ruleId, or filtering upcoming events to the
  // user-message's mentioned dates). Reference them once to satisfy
  // no-unused-vars without changing behavior.
  void matchResult;
  void userMessage;

  const ctx = moduleContext as ModuleContext & RuleContextTestInjection;

  // Test seam: bypass real loads when fixture-injected.
  if (ctx.__testRecentRules || ctx.__testUpcomingEvents || ctx.__testPrimaryDefaults) {
    return {
      contextLines: [
        `Host's primary link defaults: format=${ctx.__testPrimaryDefaults?.format ?? "video"}, duration=${ctx.__testPrimaryDefaults?.duration ?? 30} min, hours=${ctx.__testPrimaryDefaults?.hours ?? "9:00-17:00"}`,
      ],
      groundTruthBlock: renderCurrentRulesBlock(ctx.__testRecentRules ?? []),
      recentRules: ctx.__testRecentRules ?? [],
      upcomingEvents: ctx.__testUpcomingEvents ?? [],
      primaryLinkDefaults: ctx.__testPrimaryDefaults ?? {
        format: "video",
        duration: 30,
        hours: "9:00-17:00",
      },
    };
  }

  // Production wiring.
  const userId = moduleContext.user.id;

  const [user, schedule] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        preferences: true,
        meetSlug: true,
      },
    }),
    getOrComputeSchedule(userId).catch((e) => {
      console.warn(`[rule/context-loader] getOrComputeSchedule failed for ${userId}:`, e);
      return null;
    }),
  ]);

  // Extract structured rules from preferences.
  const explicit =
    (user?.preferences as { explicit?: { structuredRules?: unknown[] } } | null)?.explicit ?? null;
  const rawRules = (explicit?.structuredRules as Array<Record<string, unknown>>) ?? [];
  const recentRules: RuleSummary[] = [];
  for (const r of rawRules) {
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    const name =
      typeof r.bookable === "object" && r.bookable && typeof (r.bookable as Record<string, unknown>).name === "string"
        ? ((r.bookable as Record<string, unknown>).name as string)
        : typeof r.locationLabel === "string"
          ? (r.locationLabel as string)
          : (r.action as string) ?? "rule";
    const summary: RuleSummary = {
      id,
      name,
      type: (r.type as RuleSummary["type"]) ?? "recurring",
      action: (r.action as string) ?? "bookable",
    };
    if (Array.isArray(r.daysOfWeek)) summary.daysOfWeek = r.daysOfWeek as number[];
    if (typeof r.timeStart === "string") summary.timeStart = r.timeStart;
    if (typeof r.timeEnd === "string") summary.timeEnd = r.timeEnd;
    if (typeof r.effectiveDate === "string") summary.effectiveDate = r.effectiveDate;
    if (typeof r.expiryDate === "string") summary.expiryDate = r.expiryDate;
    recentRules.push(summary);
  }

  // Extract upcoming events from the schedule (next 60 days).
  const now = Date.now();
  const horizon = now + UPCOMING_DAYS_WINDOW * 24 * 60 * 60 * 1000;
  const upcomingEvents: UpcomingEvent[] =
    schedule?.events
      ?.filter((ev) => {
        const start = ev.start instanceof Date ? ev.start.getTime() : new Date(ev.start).getTime();
        return start >= now && start <= horizon;
      })
      .slice(0, 100)                              // bound the conflict-check input
      .map((ev) => ({
        summary: ev.summary ?? "(busy)",
        startIso: ev.start instanceof Date ? ev.start.toISOString() : String(ev.start),
        endIso: ev.end instanceof Date ? ev.end.toISOString() : String(ev.end ?? ev.start),
      })) ?? [];

  // Primary link defaults — load from the user's primary link if present.
  let primaryLinkDefaults = { format: "video", duration: 30, hours: "9:00-17:00" };
  if (user?.meetSlug) {
    try {
      const primary = await prisma.negotiationLink.findFirst({
        where: { userId, slug: user.meetSlug, type: "primary" },
        select: { parameters: true },
      });
      const params = primary?.parameters as Record<string, unknown> | undefined;
      if (params) {
        const format = typeof params.format === "string" ? params.format : "video";
        const duration = typeof params.duration === "number" ? params.duration : 30;
        const businessHours =
          (explicit as Record<string, unknown> | null)?.businessHoursStart &&
          (explicit as Record<string, unknown> | null)?.businessHoursEnd
            ? `${(explicit as Record<string, unknown>).businessHoursStart}-${(explicit as Record<string, unknown>).businessHoursEnd}`
            : "9:00-17:00";
        primaryLinkDefaults = { format, duration, hours: businessHours };
      }
    } catch (e) {
      console.warn(`[rule/context-loader] primary-link load failed for ${userId}:`, e);
    }
  }

  return {
    contextLines: [
      `Host's primary link defaults: format=${primaryLinkDefaults.format}, duration=${primaryLinkDefaults.duration} min, hours=${primaryLinkDefaults.hours}`,
    ],
    groundTruthBlock: renderCurrentRulesBlock(recentRules),
    recentRules,
    upcomingEvents,
    primaryLinkDefaults,
  };
}
