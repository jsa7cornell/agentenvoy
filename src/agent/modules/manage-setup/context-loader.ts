/**
 * Manage-setup cluster context loader — unified loader for the `manage_setup`
 * cluster (profile + rule + create_bookable_link + edit_preference).
 *
 * PR-C: Combines `profile/context-loader.ts` and `rule/context-loader.ts`
 * into a single unified loader so the manage_setup cluster has all the
 * context it needs in one shot:
 *
 *  - `gapHints`: profile gap hints (from `computeProfileGaps`)
 *  - `recentRules`: current rules (F14 [GROUND TRUTH] CURRENT RULES block)
 *  - `upcomingEvents`: calendar events for conflict-awareness
 *  - `primaryLinkDefaults`: default format/duration/hours
 *  - `contextLines`: rendered CONTEXT block for the composer
 *
 * Test seam: same `__test*` injection fields as the individual loaders, so
 * existing rule/profile bench fixtures can inject mock data.
 */
import { computeProfileGaps } from "@/lib/profile-gaps";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { formatComputedSchedule } from "@/agent/composer";
import { getUserTimezone } from "@/lib/timezone";
import type { ModuleContext, ModuleContextOutput, MatchResult } from "@/agent/modules/types";
import {
  renderCurrentRulesBlock,
  type RuleSummary,
  type UpcomingEvent,
} from "@/agent/modules/rule/context-loader";

export type { RuleSummary, UpcomingEvent };

export interface ManageSetupContext extends ModuleContextOutput {
  gapHints: string[];
  recentRules: RuleSummary[];
  upcomingEvents: UpcomingEvent[];
  primaryLinkDefaults: { format: string; duration: number; hours: string };
}

/**
 * Test-seam fields. Tests and bench fixtures inject these to bypass Prisma +
 * getOrComputeSchedule. Production callers NEVER set these fields.
 */
export interface ManageSetupContextTestInjection {
  __testProfileGapHints?: string[];
  __testRecentRules?: RuleSummary[];
  __testUpcomingEvents?: UpcomingEvent[];
  __testPrimaryDefaults?: { format: string; duration: number; hours: string };
}

const GAP_PREAMBLE = [
  "These are opportunities, not blockers. Weave them into the turn only if they fit naturally; never lecture the user.",
  "Never save a value that the host mentions in passing — always require an explicit confirmation turn from the host before calling any profile-write action.",
  "Profile writes must reflect the host's confirmed intent, not a parsed mention.",
];

function renderGapsLines(hints: readonly string[]): string[] {
  if (hints.length === 0) return [];
  return [
    "Profile gaps:",
    ...hints.map((h) => `- ${h}`),
    "",
    ...GAP_PREAMBLE,
  ];
}

const UPCOMING_DAYS_WINDOW = 60;

export async function loadManageSetupContext(
  moduleContext: ModuleContext,
  matchResult: MatchResult,
  userMessage: string,
): Promise<ManageSetupContext> {
  void matchResult;
  void userMessage;

  const ctx = moduleContext as ModuleContext & ManageSetupContextTestInjection;

  // Test seam: bypass real loads when fixture-injected.
  if (
    ctx.__testProfileGapHints ||
    ctx.__testRecentRules ||
    ctx.__testUpcomingEvents ||
    ctx.__testPrimaryDefaults
  ) {
    const gapHints = ctx.__testProfileGapHints ?? [];
    const recentRules = ctx.__testRecentRules ?? [];
    return {
      contextLines: [
        ...renderGapsLines(gapHints),
        `Host's primary link defaults: format=${ctx.__testPrimaryDefaults?.format ?? "video"}, duration=${ctx.__testPrimaryDefaults?.duration ?? 30} min, hours=${ctx.__testPrimaryDefaults?.hours ?? "9:00-17:00"}`,
      ],
      groundTruthBlock: renderCurrentRulesBlock(recentRules),
      gapHints,
      recentRules,
      upcomingEvents: ctx.__testUpcomingEvents ?? [],
      primaryLinkDefaults: ctx.__testPrimaryDefaults ?? {
        format: "video",
        duration: 30,
        hours: "9:00-17:00",
      },
    };
  }

  const userId = moduleContext.user.id;

  // Load profile gaps, user record, and schedule in parallel.
  const [gapsResult, user, schedule] = await Promise.all([
    computeProfileGaps(userId).catch((e) => {
      console.warn(`[manage-setup/context-loader] computeProfileGaps failed for ${userId}:`, e);
      return [];
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true, meetSlug: true },
    }),
    getOrComputeSchedule(userId).catch((e) => {
      console.warn(`[manage-setup/context-loader] getOrComputeSchedule failed for ${userId}:`, e);
      return null;
    }),
  ]);

  const gapHints = gapsResult.map((g) => g.hint);

  // Extract structured rules from preferences.
  const explicit =
    (user?.preferences as { explicit?: { structuredRules?: unknown[] } } | null)?.explicit ?? null;
  const rawRules = (explicit?.structuredRules as Array<Record<string, unknown>>) ?? [];
  const recentRules: RuleSummary[] = [];
  for (const r of rawRules) {
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    const name =
      typeof r.bookable === "object" &&
      r.bookable &&
      typeof (r.bookable as Record<string, unknown>).name === "string"
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

  // Extract upcoming events from schedule (next 60 days).
  const now = Date.now();
  const horizon = now + UPCOMING_DAYS_WINDOW * 24 * 60 * 60 * 1000;
  const upcomingEvents: UpcomingEvent[] =
    schedule?.events
      ?.filter((ev) => {
        const start = ev.start instanceof Date ? ev.start.getTime() : new Date(ev.start).getTime();
        return start >= now && start <= horizon;
      })
      .slice(0, 100)
      .map((ev) => ({
        summary: ev.summary ?? "(busy)",
        startIso: ev.start instanceof Date ? ev.start.toISOString() : String(ev.start),
        endIso: ev.end instanceof Date ? ev.end.toISOString() : String(ev.end ?? ev.start),
      })) ?? [];

  // Primary link defaults.
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
      console.warn(`[manage-setup/context-loader] primary-link load failed for ${userId}:`, e);
    }
  }

  // Build contextLines: DATE REFERENCE + primary defaults + profile gaps.
  const contextLines: string[] = [];
  if (schedule?.connected && schedule.slots) {
    const tz = getUserTimezone(
      (user?.preferences as Record<string, unknown> | null) ?? null,
    );
    contextLines.push(
      formatComputedSchedule(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        schedule.slots as any,
        tz,
        schedule.canWrite,
        undefined,
        { weekConvention: "sun_start" },
      ),
    );
  }
  contextLines.push(
    `Host's primary link defaults: format=${primaryLinkDefaults.format}, duration=${primaryLinkDefaults.duration} min, hours=${primaryLinkDefaults.hours}`,
  );
  contextLines.push(...renderGapsLines(gapHints));

  return {
    contextLines,
    groundTruthBlock: renderCurrentRulesBlock(recentRules),
    gapHints,
    recentRules,
    upcomingEvents,
    primaryLinkDefaults,
  };
}
