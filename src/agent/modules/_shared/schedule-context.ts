/**
 * Shared schedule-path context loader.
 *
 * Replicates the inline context-build at chat/route.ts:968-1089 (pre-PR3b-i)
 * so every schedule-path module (`inquire`, `query_calendar`, `query_event`,
 * `chat`, `create_link`, `modify_link`, `cancel_link`, `schedule`) reads
 * identical truth from one helper.
 *
 * Returns context lines in the canonical order:
 *  1. Calendar slots (formatComputedSchedule + formatOfferableSlots) when connected
 *  2. Upcoming events (14-day window) when connected
 *  3. "Calendar: Not connected" otherwise
 *  4. Persistent preferences
 *  5. Situational context (near-term)
 *  6. Host directives
 *  7. Reusable links (primary + active bookable)
 *  8. Active sessions list
 *  9. Current time
 * 10. Calibration status
 *
 * Channel session lifecycle (3-day rolling window for history) is NOT loaded
 * here — that's the route layer's responsibility (channel session create/expire
 * is a side-effect that runs unconditionally for schedule-path intents).
 *
 * Test seam: `__testScheduleContext` lets tests + bench fixtures inject
 * pre-loaded state without prisma + getOrComputeSchedule. Production
 * code paths NEVER set this field.
 */
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule, type CalendarEvent } from "@/lib/calendar";
import {
  formatComputedSchedule,
  formatOfferableSlots,
} from "@/agent/composer";
import { getUserTimezone, shortTimezoneLabel } from "@/lib/timezone";
import { computeProfileGaps, type ProfileGap } from "@/lib/profile-gaps";
import {
  computeOnboardingState,
  type OnboardingState,
} from "@/lib/onboarding/dormant-eligibility";
import type {
  ModuleContext,
  ModuleContextOutput,
  MatchResult,
} from "@/agent/modules/types";

export interface ScheduleContext extends ModuleContextOutput {
  /** Whether the host's calendar is connected. Modules can branch on this. */
  calendarConnected: boolean;
  /** Number of scored slots — surfaced for the route's `emitStatus("scoring", { slots: { count } })`. */
  scoredSlotCount: number;
  /** Host timezone label (e.g., "PT", "ET") for status copy interpolation. */
  tzLabel: string | null;
  /** Active session count for telemetry. */
  activeSessionCount: number;
  /**
   * Profile gaps active on this turn (PR-C — progressive-profiling fold-in).
   * Gaps whose hint strings were injected into contextLines. The runner
   * reads this to populate `moduleGuard.gapsSurfaced` for telemetry.
   * Empty array when no gaps are active; never undefined in production loader.
   */
  profileGaps: ProfileGap[];
  /**
   * Aggregated onboarding state (PR-C of
   * `2026-05-05_conversational-onboarding-vision`). Populated by the
   * production loader; absent on the test-injection path unless a fixture
   * supplies it. Modules that branch on onboarding-state (chat
   * `post-calibration`, future PR-D variants) read this field; modules that
   * don't can ignore it.
   */
  onboardingState?: OnboardingState;
}

/**
 * Test-seam fields on ModuleContext. Tests + bench fixtures inject these to
 * skip prisma + getOrComputeSchedule. Production callers NEVER set them.
 */
export interface ScheduleContextTestInjection {
  __testScheduleContext?: {
    user: {
      name: string | null;
      preferences: unknown;
      meetSlug: string | null;
      persistentKnowledge: string | null;
      upcomingSchedulePreferences: string | null;
      hostDirectives: unknown;
      lastCalibratedAt: Date | null;
    };
    scheduleResult: {
      connected: boolean;
      canWrite: boolean;
      slots?: unknown[];
      events?: CalendarEvent[];
    } | null;
    activeSessions: Array<{
      id: string;
      title: string | null;
      status: string;
      statusLabel: string | null;
      guestEmail: string | null;
      link: { inviteeName: string | null; code: string | null; slug: string | null };
    }>;
    now?: Date;
  };
}

/**
 * Format upcoming named calendar events (14-day window) so the composer can
 * resolve "cancel my meeting with Katie" even when the NegotiationSession is
 * old or below the take:20 limit. Pulled out of the route so PR3b-i and
 * PR3b-iii share the same formatter.
 */
export function formatUpcomingEvents(
  events: CalendarEvent[],
  tz: string,
): string | null {
  const now = Date.now();
  const cutoff = now + 14 * 24 * 60 * 60 * 1000;
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
    hour12: true,
  });
  const relevant = events
    .filter((e) => {
      if (!e.summary || e.summary === "(no title)") return false;
      const start = new Date(e.start).getTime();
      return start >= now && start <= cutoff;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 15);
  if (relevant.length === 0) return null;
  const lines = relevant.map((e) => {
    const startLabel = dateFmt.format(new Date(e.start));
    const attendeePart = (e.attendeeCount ?? 0) > 1
      ? ` (${e.attendeeCount} guests)`
      : "";
    return `- "${e.summary}" — ${startLabel}${attendeePart}`;
  });
  return `Upcoming calendar events (next 14 days — use these to resolve cancel/reschedule requests by name):\n${lines.join("\n")}`;
}

/**
 * Build the contextLines for a schedule-path module from the loaded state.
 * Pure function; no I/O. Pulled out so the production loader and the
 * test-seam injection share the same formatting.
 */
function buildContextLines(args: {
  user: {
    preferences: unknown;
    meetSlug: string | null;
    persistentKnowledge: string | null;
    upcomingSchedulePreferences: string | null;
    hostDirectives: unknown;
    lastCalibratedAt: Date | null;
  };
  scheduleResult: {
    connected: boolean;
    canWrite: boolean;
    slots?: unknown[];
    events?: CalendarEvent[];
  } | null;
  activeSessions: Array<{
    id: string;
    title: string | null;
    status: string;
    statusLabel: string | null;
    guestEmail: string | null;
    link: { inviteeName: string | null; code: string | null; slug: string | null };
  }>;
  now: Date;
  userId: string;
}): {
  contextLines: string[];
  calendarConnected: boolean;
  scoredSlotCount: number;
  tzLabel: string | null;
} {
  const { user, scheduleResult, activeSessions, now } = args;
  const contextParts: string[] = [];
  const hostPrefs = user.preferences as Record<string, unknown> | null;
  const tz = getUserTimezone(hostPrefs);
  const tzLabel = shortTimezoneLabel(tz);

  let calendarConnected = false;
  let scoredSlotCount = 0;
  if (scheduleResult?.connected) {
    calendarConnected = true;
    scoredSlotCount = scheduleResult.slots?.length ?? 0;
    contextParts.push(
      formatComputedSchedule(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scheduleResult.slots as any,
        tz,
        scheduleResult.canWrite,
        undefined,
        { weekConvention: "sun_start" },
      ),
    );
    contextParts.push(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatOfferableSlots(scheduleResult.slots as any, tz, scheduleResult.canWrite),
    );
    if (scheduleResult.events) {
      const upcomingLines = formatUpcomingEvents(scheduleResult.events, tz);
      if (upcomingLines) contextParts.push(upcomingLines);
    }
  }
  if (!calendarConnected) {
    contextParts.push("Calendar: Not connected");
  }

  if (user.persistentKnowledge) {
    contextParts.push(`Host's persistent preferences:\n${user.persistentKnowledge}`);
  }
  if (user.upcomingSchedulePreferences) {
    contextParts.push(`Host's situational context (near-term):\n${user.upcomingSchedulePreferences}`);
  }
  if (user.hostDirectives && (user.hostDirectives as string[]).length > 0) {
    contextParts.push(
      `Host directives (highest priority):\n${(user.hostDirectives as string[])
        .map((d) => `- ${d}`)
        .join("\n")}`,
    );
  }

  // Reusable links (primary + active bookable links).
  {
    const explicitPrefs = (hostPrefs?.explicit as Record<string, unknown> | undefined) ?? {};
    const structuredRules =
      (explicitPrefs.structuredRules as Array<{
        action?: string;
        status?: string;
        bookable?: { name?: string; title?: string; linkSlug?: string; linkCode?: string };
      }> | undefined) ?? [];
    const primaryLinkName =
      typeof explicitPrefs.primaryLinkName === "string" &&
      (explicitPrefs.primaryLinkName as string).trim()
        ? (explicitPrefs.primaryLinkName as string)
        : "Primary link";
    const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || "https://agentenvoy.ai";
    const lines: string[] = [];
    if (user.meetSlug) {
      lines.push(`- "${primaryLinkName}" (default): ${origin}/meet/${user.meetSlug}`);
    }
    for (const r of structuredRules) {
      if (r.action !== "bookable" || r.status !== "active") continue;
      const linkData = r.bookable;
      if (!linkData) continue;
      const name = linkData.name ?? linkData.title ?? "Drop-in Hours";
      const url =
        linkData.linkSlug && linkData.linkCode
          ? `${origin}/meet/${linkData.linkSlug}/${linkData.linkCode}`
          : "(url unavailable)";
      lines.push(`- "${name}": ${url}`);
    }
    if (lines.length > 0) {
      contextParts.push(
        `Host's reusable links (answer "what's my X link" / "share my X link" from this list — match by name fuzzy, case-insensitive; if the host asks generally for "my links" reply with the full list):\n${lines.join("\n")}`,
      );
    }
  }

  // Active sessions list.
  if (activeSessions.length > 0) {
    const sessionList = activeSessions
      .map((s) => {
        const guest = s.link.inviteeName || s.guestEmail || "unknown";
        const note = s.statusLabel ? `, note: ${s.statusLabel}` : "";
        const code = s.link.code ?? null;
        const url = s.link.slug && s.link.code
          ? `/meet/${s.link.slug}/${s.link.code}`
          : null;
        const ids = [
          `sessionId: ${s.id}`,
          code ? `linkCode: ${code}` : null,
          url ? `url: ${url}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        return `- "${s.title || "Untitled"}" (${ids}) — status: ${s.status}, guest: ${guest}${note}`;
      })
      .join("\n");
    contextParts.push(
      `Sessions (active and confirmed — "agreed" sessions have a confirmed calendar event and can be cancelled or rescheduled):\n${sessionList}\n\n` +
        `You can execute actions on these sessions using [ACTION] blocks. ` +
        `For session-scoped actions (update_format / update_time / update_location / cancel / hold_slot / archive) pass sessionId. ` +
        `For link-scoped actions (update_link / expand_link) pass linkCode — it's the 6-char string after /meet/{slug}/ in the url above.`,
    );
  } else {
    contextParts.push("Active sessions: None");
  }

  // Current time.
  const timeStr = now.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: tz,
  });
  contextParts.push(`Current time: ${timeStr}`);

  // Calibration status.
  if (!user.lastCalibratedAt) {
    contextParts.push(
      "Calibration: NEVER — this host has not been calibrated. Run onboarding calibration (see ONBOARDING CALIBRATION below).",
    );
  } else {
    const daysSince = Math.floor(
      (Date.now() - new Date(user.lastCalibratedAt).getTime()) / (1000 * 60 * 60 * 24),
    );
    if (daysSince >= 10) {
      contextParts.push(
        `Calibration: Last calibrated ${daysSince} days ago. Consider running a check-in (see CHECK-IN CALIBRATION below).`,
      );
    } else {
      contextParts.push(
        `Calibration: Last calibrated ${daysSince} day${daysSince !== 1 ? "s" : ""} ago.`,
      );
    }
  }

  return {
    contextLines: contextParts,
    calendarConnected,
    scoredSlotCount,
    tzLabel,
  };
}

/**
 * Format profile gap hints for injection into the context.
 *
 * Mirrors the legacy chat-route injection pattern. The meta-rule at the top
 * is load-bearing: it prevents the LLM from doing silent writes (B1 fold per
 * progressive-profiling proposal §2.4). Never remove it.
 */
function buildGapContextLines(gaps: ProfileGap[]): string[] {
  if (gaps.length === 0) return [];
  const hintLines = gaps.map((g) => `- ${g.hint}`).join("\n");
  return [
    [
      "PROFILE GAPS (progressive-profiling — IMPORTANT RULES):",
      "  1. You MAY ask about a gap on a NATURAL turn when it is relevant.",
      "  2. You MUST NOT write a value unless the host explicitly confirms on the FOLLOWING turn.",
      "  3. Only surface one gap per turn — don't dump a list of questions.",
      "",
      hintLines,
    ].join("\n"),
  ];
}

/**
 * Production loader. Reads from prisma + getOrComputeSchedule. Tests + bench
 * fixtures override via `__testScheduleContext` on ModuleContext.
 */
export async function loadScheduleContext(
  moduleContext: ModuleContext,
  matchResult: MatchResult,
  userMessage: string,
): Promise<ScheduleContext> {
  void matchResult;
  void userMessage;

  const ctx = moduleContext as ModuleContext & ScheduleContextTestInjection;
  if (ctx.__testScheduleContext) {
    const t = ctx.__testScheduleContext;
    const built = buildContextLines({
      user: t.user,
      scheduleResult: t.scheduleResult,
      activeSessions: t.activeSessions,
      now: t.now ?? new Date(),
      userId: moduleContext.user.id,
    });
    // Tests that inject __testScheduleContext get an empty gap list — they
    // control the context explicitly and don't need live gap computation.
    return {
      contextLines: built.contextLines,
      calendarConnected: built.calendarConnected,
      scoredSlotCount: built.scoredSlotCount,
      tzLabel: built.tzLabel,
      activeSessionCount: t.activeSessions.length,
      profileGaps: [],
    };
  }

  const userId = moduleContext.user.id;
  // PR-C (conversational-onboarding §3.3): scan recent channel messages for
  // onboarding terminal markers. 30d window so terminal markers from a
  // completed calibrate arc remain visible across vacation gaps; the actual
  // 5-minute `post-calibration` window is enforced by the chat-module
  // variant selector reading `lastCalibrationCompletionAt`.
  const onboardingMessageCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [user, scheduleResult, activeSessions, profileGaps, onboardingMessages] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          name: true,
          preferences: true,
          meetSlug: true,
          persistentKnowledge: true,
          upcomingSchedulePreferences: true,
          hostDirectives: true,
          lastCalibratedAt: true,
        },
      }),
      getOrComputeSchedule(userId).catch((e) => {
        console.warn(`[schedule-context] getOrComputeSchedule failed for ${userId}:`, e);
        return null;
      }),
      prisma.negotiationSession.findMany({
        where: { hostId: userId, archived: false, status: { not: "cancelled" } },
        include: {
          link: {
            select: {
              inviteeName: true,
              inviteeEmail: true,
              topic: true,
              customTitle: true,
              code: true,
              slug: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
      // PR-C: progressive-profiling fold-in. Compute gaps alongside the schedule
      // so the hints are module-resident and route through moduleGuardBucket
      // telemetry. Defensive: gap failure is non-fatal; empty array degrades
      // gracefully (no hints, no telemetry for this turn).
      computeProfileGaps(userId).catch((e) => {
        console.warn(`[schedule-context] computeProfileGaps failed for ${userId}:`, e);
        return [] as ProfileGap[];
      }),
      // PR-C: terminal-marker scan for OnboardingState. Scoped to active
      // channel; non-dashboard surfaces (no channel) get []. Defensive
      // catch — onboardingState aggregation degrades gracefully if the
      // scan fails (chat module's selector treats null timestamps as
      // "no completion ever").
      moduleContext.channel?.id
        ? prisma.channelMessage
            .findMany({
              where: {
                channelId: moduleContext.channel.id,
                createdAt: { gte: onboardingMessageCutoff },
              },
              select: { metadata: true, createdAt: true },
              orderBy: { createdAt: "desc" },
            })
            .catch((e) => {
              console.warn(
                `[schedule-context] onboarding-message scan failed for ${userId}:`,
                e,
              );
              return [] as Array<{ metadata: unknown; createdAt: Date }>;
            })
        : Promise.resolve([] as Array<{ metadata: unknown; createdAt: Date }>),
    ]);

  if (!user) {
    throw new Error(`[schedule-context] user ${userId} not found`);
  }

  const built = buildContextLines({
    user,
    scheduleResult,
    activeSessions: activeSessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      statusLabel: s.statusLabel,
      guestEmail: s.guestEmail,
      link: {
        inviteeName: s.link.inviteeName,
        code: s.link.code,
        slug: s.link.slug,
      },
    })),
    now: new Date(),
    userId,
  });

  // Inject profile gap hints after the base context lines. The hints live
  // in a separate section so the composer can read calibration status first.
  const gapLines = buildGapContextLines(profileGaps);
  const contextLines = [...built.contextLines, ...gapLines];

  // PR-C: aggregate OnboardingState. Defensive: any failure here MUST NOT
  // fail the whole loader (the chat / recalibrate base paths still work
  // without onboardingState). On error, omit the field — modules that
  // branch on it treat undefined as "no signal."
  let onboardingState: OnboardingState | undefined;
  try {
    onboardingState = await computeOnboardingState(
      userId,
      // Prisma's metadata column is `JsonValue` which is wider than the
      // `Record<string, unknown> | null | undefined` shape DatedMessageMetaSlice
      // requires. The reader-side helpers in dormant-eligibility.ts only
      // touch `metadata?.kind` / `metadata?.subkind` / `metadata?.terminal`
      // (with optional chaining), so non-object JsonValues degrade cleanly
      // (treated as "no marker"). Cast to keep the helper interface tight.
      onboardingMessages.map((m) => ({
        createdAt: m.createdAt,
        metadata:
          m.metadata && typeof m.metadata === "object" && !Array.isArray(m.metadata)
            ? (m.metadata as Record<string, unknown>)
            : null,
      })),
      profileGaps.length,
    );
  } catch (e) {
    console.warn(
      `[schedule-context] computeOnboardingState failed for ${userId}:`,
      e,
    );
    onboardingState = undefined;
  }

  return {
    contextLines,
    calendarConnected: built.calendarConnected,
    scoredSlotCount: built.scoredSlotCount,
    tzLabel: built.tzLabel,
    activeSessionCount: activeSessions.length,
    profileGaps,
    onboardingState,
  };
}
