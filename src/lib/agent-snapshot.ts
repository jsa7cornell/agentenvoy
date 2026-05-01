/**
 * Agent snapshot — a single-fetch JSON view of a meeting link's bookable state.
 *
 * Two presentations share this assembler:
 *   1. Embedded `<script type="application/agent+json" data-agent-snapshot="v1">`
 *      block on contextual `/meet/<slug>/<code>` pages (NOT bare-vanity).
 *   2. Standalone JSON at `GET /meet/<slug>[/<code>]/agent.json`.
 *
 * The shape is the same as MCP `get_availability` would return for an
 * anonymous caller, plus the `parameters` envelope from
 * `get_meeting_parameters`, plus a `booking` block pointing at
 * `POST /api/mcp tools/call propose_lock`. **Zero new business logic** —
 * defaults match `get_availability` (limit = 20, no dateRange floor) and
 * the slot pipeline mirrors `tools.ts handleGetAvailability`. A drift
 * CI lint asserts the two surfaces emit identical slot lists for
 * identical inputs at the same instant.
 *
 * Per the 2026-04-30 single-fetch-agent-surface proposal §B2 fold:
 * defaults stay aligned with `get_availability` so this composition is
 * a presentation change, not a policy change.
 *
 * No in-memory cache lives here — Vercel serverless invalidates that
 * design. Cache discipline is: (a) `Cache-Control: public, max-age=15`
 * on the route response (handled by route handlers, not this module),
 * (b) the existing `ComputedSchedule.inputHash` DB cache in
 * `getOrComputeSchedule`, (c) `React.cache()` on the page-embed path
 * (handled by the page component, not this module).
 */
import type { NegotiationLink } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getUserTimezone, formatIsoWithOffset } from "@/lib/timezone";
import {
  applyEventOverrides,
  filterByDuration,
  getTier,
  type LinkParameters,
  type UserPreferences,
  type CompiledRules,
  type ScoredSlot,
} from "@/lib/scoring";
import { getOrComputeSchedule } from "@/lib/calendar";
import {
  compileOfficeHoursLinks,
  type AvailabilityPreference,
} from "@/lib/availability-rules";
import {
  applyOfficeHoursWindow,
  type ConfirmedBooking,
} from "@/lib/office-hours";
import { resolveParameters } from "@/lib/mcp/parameter-resolver";
import { buildRulesPassthrough } from "@/lib/mcp/tools";

/**
 * The wire shape consumed by external agents. `application/agent+json`
 * (NOT JSON-LD) — Schema.org's `Schedule` type is for repeating-event
 * schedules and the type mismatch made the SEO benefit illusory; using
 * a custom MIME keeps the contract clean (per N7 review fold).
 */
export type AgentSnapshot = {
  schemaVersion: "2026-04-30";
  meetingUrl: string;
  host: { name: string | null; timezone: string };
  /** Same shape as get_meeting_parameters.parameters. */
  parameters: ReturnType<typeof resolveParameters>;
  /** Same shape as get_meeting_parameters.rules. */
  rules: Record<string, unknown>;
  /** Same shape as get_availability.slots. Best-first, capped at limit. */
  slots: WireSlot[];
  /**
   * Reserved for bilateral availability (when a guest agent provides
   * its principal's busy times). Omitted in v1; populated when the
   * separate bilateral proposal lands. Per N4 review fold — reserving
   * the contract slot now so a future proposal doesn't reshape this output.
   */
  viewerOverlap?: undefined;
  /**
   * How to actually book a slot. Currently always points at the public
   * MCP endpoint. Snapshot is guest-agent-targeted; host-side AI surfaces
   * use `/api/mcp/host` with PAT-bearer auth, not this snapshot.
   */
  booking: {
    endpoint: string;
    method: "POST";
    tool: "propose_lock";
    auth: "url-capability";
    tokenParam: "meetingUrl";
    guidance: string;
  };
};

export type WireSlot = {
  start: string;
  end: string;
  localStart: string;
  score: number;
  tier?: "first_offer" | "stretch1" | "stretch2";
  preferred?: true;
};

export type AgentSnapshotOpts = {
  /** YYYY-MM-DD inclusive range. Optional — when omitted, full schedule horizon. */
  dateRange?: { start: string; end: string };
  /** Display timezone for clipping. Defaults to host timezone. */
  timezone?: string;
  /** Cap on slot count (default 20, max 200) — same as get_availability. */
  limit?: number;
};

const DEFAULT_LIMIT = 20;

/**
 * Build the snapshot. Pure-ish — DB reads (host preferences, computed
 * schedule, office-hours rules siblings, link.parameters) + score-engine
 * transforms. No side effects; no logging. Caller controls cache headers.
 */
/**
 * Public entry point. Pure-ish — DB reads (host preferences, computed
 * schedule, office-hours rules siblings, link.parameters) + score-engine
 * transforms. No side effects; no logging. Caller controls cache headers.
 *
 * Note on caching: redundant slot computation is already prevented by the
 * DB-backed `ComputedSchedule.inputHash` cache inside `getOrComputeSchedule`
 * (`calendar.ts:884-899`). Per-invocation memoization via `React.cache` was
 * considered (per the proposal §B1 fold) but the current call sites only
 * invoke this once per render, so it's not yet motivated. Add the wrapper
 * if/when multiple components in one render want the same snapshot.
 */
export async function buildAgentSnapshot(
  link: NegotiationLink,
  hostUser: { name: string | null; preferences: unknown },
  opts: AgentSnapshotOpts = {},
): Promise<AgentSnapshot> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const rules = (link.parameters ?? {}) as LinkParameters;

  const hostPreferences = hostUser.preferences as UserPreferences | null;
  const prefsRecord = (hostPreferences ?? {}) as Record<string, unknown>;
  const timezone = getUserTimezone(prefsRecord);
  const compiledRules =
    ((hostPreferences?.explicit as Record<string, unknown> | undefined)
      ?.compiled as CompiledRules | undefined) ?? null;

  const parameters = resolveParameters({
    rules,
    hostPreferences,
    hostTimezone: timezone,
    compiledRules,
  });
  const rulesPassthrough = buildRulesPassthrough(rules);

  const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
  const meetingUrl = link.code
    ? `${baseUrl}/meet/${link.slug}/${link.code}`
    : `${baseUrl}/meet/${link.slug}`;

  const booking: AgentSnapshot["booking"] = {
    endpoint: `${baseUrl}/api/mcp`,
    method: "POST",
    tool: "propose_lock",
    auth: "url-capability",
    tokenParam: "meetingUrl",
    guidance:
      "POST tools/call with name: 'propose_lock' and the meetingUrl above as the meetingUrl argument. Possessing the URL is the authorization. " +
      "On success the response includes both `sessionId` and a canonical `meetingUrl` (with code) — save them; you'll need either to cancel or reschedule. " +
      "To cancel: POST tools/call `cancel_meeting` with `{ meetingUrl, sessionId }`. To reschedule: POST tools/call `reschedule_meeting` with `{ meetingUrl, sessionId, newSlot: { start } }`.",
  };

  const baseSnapshot: Omit<AgentSnapshot, "slots"> = {
    schemaVersion: "2026-04-30",
    meetingUrl,
    host: { name: hostUser.name, timezone },
    parameters,
    rules: rulesPassthrough,
    booking,
  };

  // Pull the host's global scored schedule.
  const schedule = await getOrComputeSchedule(link.userId);
  if (!schedule.connected) {
    return { ...baseSnapshot, slots: [] };
  }

  // The slot pipeline mirrors `tools.ts handleGetAvailability`. Per the
  // proposal's N2 fold (don't refactor handleGetAvailability in this PR),
  // these are PARALLEL implementations — a CI drift lint asserts they
  // emit identical output for identical inputs.
  let slots: ScoredSlot[] = applyEventOverrides(schedule.slots, rules, timezone);

  if (link.recurringWindowId) {
    const explicit = prefsRecord.explicit as Record<string, unknown> | undefined;
    const allRules =
      (explicit?.structuredRules as AvailabilityPreference[] | undefined) ?? [];
    const compiledLinks = compileOfficeHoursLinks(allRules);
    const compiled = compiledLinks.find((l) => l.ruleId === link.recurringWindowId);
    if (compiled) {
      const siblings = await prisma.negotiationSession.findMany({
        where: {
          status: "agreed",
          agreedTime: { not: null },
          link: { recurringWindowId: link.recurringWindowId },
        },
        select: { agreedTime: true, duration: true },
      });
      const confirmedBookings: ConfirmedBooking[] = siblings
        .filter((s) => s.agreedTime)
        .map((s) => ({
          start: s.agreedTime!.toISOString(),
          end: new Date(
            s.agreedTime!.getTime() + (s.duration || compiled.durationMinutes) * 60_000,
          ).toISOString(),
        }));
      slots = applyOfficeHoursWindow({
        rule: compiled,
        slots,
        timezone,
        confirmedBookings,
      });
    }
  }

  // Score filter — exclusive overrides win; VIP gets stretches; everyone
  // else is bookable-band only. Mirrors `tools.ts` ~315.
  const isVip = !!(rules as Record<string, unknown>).isVip;
  const hasExclusive = slots.some((s) => s.score === -2);
  if (hasExclusive) {
    slots = slots.filter((s) => s.score <= -1);
  } else if (isVip) {
    slots = slots.filter((s) => s.score <= 3);
  } else {
    slots = slots.filter((s) => s.score <= 1);
  }

  // Drop past slots.
  const now = Date.now();
  slots = slots.filter((s) => new Date(s.start).getTime() > now);

  // guestPicks.window clamp.
  const guestPicks = (rules as Record<string, unknown>).guestPicks as
    | { window?: { startHour?: number; endHour?: number } }
    | undefined;
  const win = guestPicks?.window;
  if (
    win &&
    typeof win.startHour === "number" &&
    typeof win.endHour === "number" &&
    win.endHour > win.startHour
  ) {
    const { slotStartInWindow } = await import("@/lib/time-of-day");
    slots = slots.filter((s) =>
      slotStartInWindow(s.start, { startHour: win.startHour!, endHour: win.endHour! }, timezone),
    );
  }

  // Duration chain filter.
  const duration = (rules as Record<string, unknown>).duration as number | undefined;
  const minDuration = (rules as Record<string, unknown>).minDuration as
    | number
    | undefined;
  if (duration && duration > 30) {
    slots = filterByDuration(slots, duration, minDuration);
  }

  // Caller-supplied dateRange clip.
  if (opts.dateRange) {
    const clipTz = opts.timezone ?? timezone;
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: clipTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const { start, end } = opts.dateRange;
    slots = slots.filter((s) => {
      const local = dateFmt.format(new Date(s.start));
      if (start && local < start) return false;
      if (end && local > end) return false;
      return true;
    });
  }

  // Sort best-first, then cap.
  slots.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });
  if (slots.length > limit) {
    slots = slots.slice(0, limit);
  }

  // Format localStart in host TZ as full ISO 8601 with offset suffix
  // (e.g. "2026-05-04T09:30:00-07:00"). Friend's FEEDBACK.md 2026-05-01:
  // earlier offset-less format ("2026-05-04T09:30:00") was ambiguous.
  const wireSlots: WireSlot[] = slots.map((s) => {
    const tier = getTier(s, rules, timezone);
    const wireTier =
      tier === "first-offer"
        ? ("first_offer" as const)
        : tier === "stretch1"
          ? ("stretch1" as const)
          : tier === "stretch2"
            ? ("stretch2" as const)
            : undefined;
    const preferred = s.score <= -1;
    const localStart = formatIsoWithOffset(new Date(s.start), timezone);
    return {
      start: s.start,
      end: s.end,
      localStart,
      score: s.score,
      ...(wireTier ? { tier: wireTier } : {}),
      ...(preferred ? { preferred: true as const } : {}),
    };
  });

  return { ...baseSnapshot, slots: wireSlots };
}
