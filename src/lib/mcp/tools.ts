/**
 * MCP tool handlers.
 *
 * Thin per-tool functions that:
 *   1. Parse input (already validated by the SDK against `MCP_TOOLS[name].input`).
 *   2. Call `authorizeMcpCall` — one choke-point for URL parsing, link
 *      resolution, rate-limiting. Returns on any auth failure.
 *   3. Call the underlying pipeline / resolver.
 *   4. Shape the response to match `MCP_TOOLS[name].output`.
 *
 * Each handler is pure-ish — side effects (DB writes, side-effect dispatch)
 * live inside the pipelines (confirm-pipeline.ts, etc.), not here.
 *
 * The HTTP route (src/app/api/mcp/route.ts) calls `registerMcpTools(server)`
 * to wire every handler into an `McpServer` instance per-request. Stateless
 * mode — no cross-request state lives here.
 */
import { prisma } from "@/lib/prisma";
import { getUserTimezone } from "@/lib/timezone";
import {
  applyEventOverrides,
  getTier,
  filterByDuration,
  type LinkRules,
  type UserPreferences,
  type CompiledRules,
  type ScoredSlot,
} from "@/lib/scoring";
import { getOrComputeSchedule } from "@/lib/calendar";
import {
  compileOfficeHoursLinks,
  type AvailabilityRule,
} from "@/lib/availability-rules";
import {
  applyOfficeHoursWindow,
  type ConfirmedBooking,
} from "@/lib/office-hours";
import { authorizeMcpCall, type AuthorizeResult } from "@/lib/mcp/auth";
import { resolveParameters } from "@/lib/mcp/parameter-resolver";
import {
  MCP_TOOLS,
  type McpToolName,
  getMeetingParametersInput,
  getAvailabilityInput,
} from "@/lib/mcp/schemas";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Response envelope used by the SDK (CallToolResult shape).
// ---------------------------------------------------------------------------

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Build a CallToolResult from a JSON-shaped response. The SDK requires a
 * `content` array; we also attach `structuredContent` so clients that prefer
 * typed access (e.g. Anthropic tool_use) can skip the JSON.parse step.
 */
function asCallResult(
  json: Record<string, unknown>,
  opts: { isError?: boolean } = {}
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    structuredContent: json,
    ...(opts.isError ? { isError: true } : {}),
  };
}

// Map auth-error codes onto the user-facing refusal reasons the schemas allow.
function authErrorToRefusal(
  auth: Extract<AuthorizeResult, { ok: false }>
): { reason: string; message: string; retryAfterSeconds?: number } {
  switch (auth.error) {
    case "invalid_url":
    case "not_meeting_path":
    case "link_not_found":
      return {
        reason: "link_not_found",
        message: "Meeting URL did not resolve to an active link.",
      };
    case "link_expired":
      return {
        reason: "link_expired",
        message: "This meeting link has expired.",
      };
    case "rate_limit_exceeded":
    case "rate_limit_store_unavailable":
      return {
        reason: "rate_limited",
        message: "Too many requests — back off and retry.",
        retryAfterSeconds: auth.retryAfterSeconds,
      };
    default:
      return {
        reason: "link_not_found",
        message: "Meeting URL did not resolve.",
      };
  }
}

// ---------------------------------------------------------------------------
// Handler: get_meeting_parameters
// ---------------------------------------------------------------------------

export async function handleGetMeetingParameters(
  args: z.infer<typeof getMeetingParametersInput>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "get_meeting_parameters",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;

  // Load the host's preferences for the fallback chain.
  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { preferences: true },
  });
  const hostPreferences = (host?.preferences ?? null) as UserPreferences | null;
  const hostTimezone = getUserTimezone(
    hostPreferences as Record<string, unknown> | null
  );

  // `compiledRules` lives inside preferences.explicit.compiled (scoring.ts:1100).
  const compiledRules =
    ((hostPreferences?.explicit as Record<string, unknown> | undefined)
      ?.compiled as CompiledRules | undefined) ?? null;

  const rules = (link.rules ?? {}) as LinkRules;
  const slotStart = args.slotStart ? new Date(args.slotStart) : undefined;

  const parameters = resolveParameters({
    rules,
    hostPreferences,
    hostTimezone,
    slotStart,
    compiledRules,
  });

  return asCallResult({
    ok: true,
    meetingUrl: args.meetingUrl,
    parameters,
    rules: {
      ...(rules.activity ? { activity: rules.activity } : {}),
      ...(rules.activityIcon ? { activityIcon: rules.activityIcon } : {}),
      ...(rules.timingLabel ? { timingLabel: rules.timingLabel } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Handler: get_availability
// ---------------------------------------------------------------------------

/**
 * Return the host's scored, filtered slot list through the lens of this link.
 * Mirrors the logic in `/api/negotiate/slots` (the UI widget's source) but:
 *   - Skips bilateral compute — external agents don't have a guest calendar
 *     to XOR with. (If the caller has one, they can locally subtract their
 *     own busy times.)
 *   - Accepts an optional `dateRange` to clip the server-side result.
 *   - Emits a flat `{ start, end, score, tier }` array — tier is the LLM's
 *     offerability signal (first_offer / stretch1 / stretch2).
 */
export async function handleGetAvailability(
  args: z.infer<typeof getAvailabilityInput>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "get_availability",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;
  const rules = (link.rules ?? {}) as LinkRules;

  // Load the host's preferences for tz + structuredRules (office hours).
  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { preferences: true },
  });
  const prefs = (host?.preferences ?? {}) as Record<string, unknown>;
  const timezone = getUserTimezone(prefs);

  // Pull the host's global scored schedule.
  const schedule = await getOrComputeSchedule(link.userId);
  if (!schedule.connected) {
    return asCallResult({ ok: true, timezone, slots: [] });
  }

  // Event-level overrides from link rules (dateRange, preferredDays, etc).
  let slots: ScoredSlot[] = applyEventOverrides(schedule.slots, rules, timezone);

  // Office-hours transform if the link was spawned from a rule.
  if (link.sourceRuleId) {
    const explicit = prefs.explicit as Record<string, unknown> | undefined;
    const allRules =
      (explicit?.structuredRules as AvailabilityRule[] | undefined) ?? [];
    const compiledLinks = compileOfficeHoursLinks(allRules);
    const compiled = compiledLinks.find((l) => l.ruleId === link.sourceRuleId);
    if (compiled) {
      const siblings = await prisma.negotiationSession.findMany({
        where: {
          status: "agreed",
          agreedTime: { not: null },
          link: { sourceRuleId: link.sourceRuleId },
        },
        select: { agreedTime: true, duration: true },
      });
      const confirmedBookings: ConfirmedBooking[] = siblings
        .filter((s) => s.agreedTime)
        .map((s) => {
          const start = s.agreedTime!;
          const durationMin = s.duration || compiled.durationMinutes;
          return {
            start: start.toISOString(),
            end: new Date(start.getTime() + durationMin * 60 * 1000).toISOString(),
          };
        });
      slots = applyOfficeHoursWindow({
        rule: compiled,
        slots,
        timezone,
        confirmedBookings,
      });
    }
  }

  // Score filter — mirrors slots-route. Exclusive overrides win; VIP links
  // permit protected-band stretches; everyone else gets score ≤ 1.
  const isVip = !!(rules as Record<string, unknown>).isVip;
  const hasExclusive = slots.some((s) => s.score === -2);
  if (hasExclusive) {
    slots = slots.filter((s) => s.score <= -1);
  } else if (isVip) {
    slots = slots.filter((s) => s.score <= 3);
  } else {
    slots = slots.filter((s) => s.score <= 1);
  }

  // Drop past slots (the calendar cache starts 7 days back for incremental sync).
  const now = Date.now();
  slots = slots.filter((s) => new Date(s.start).getTime() > now);

  // guestPicks.window clamp in host tz.
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
    const clampWindow = { startHour: win.startHour, endHour: win.endHour };
    slots = slots.filter((s) =>
      slotStartInWindow(s.start, clampWindow, timezone)
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

  // Caller-supplied dateRange clip (input is YYYY-MM-DD in the requested tz,
  // or the host tz by default).
  if (args.dateRange) {
    const clipTz = args.timezone ?? timezone;
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: clipTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const { start, end } = args.dateRange;
    slots = slots.filter((s) => {
      const local = dateFmt.format(new Date(s.start));
      if (start && local < start) return false;
      if (end && local > end) return false;
      return true;
    });
  }

  // Emit wire shape. Map "first-offer" (internal) → "first_offer" (schema).
  const wireSlots = slots.map((s) => {
    const tier = getTier(s, rules, timezone);
    const wireTier =
      tier === "first-offer"
        ? "first_offer"
        : tier === "stretch1"
          ? "stretch1"
          : tier === "stretch2"
            ? "stretch2"
            : undefined;
    return {
      start: s.start,
      end: s.end,
      score: s.score,
      ...(wireTier ? { tier: wireTier } : {}),
    };
  });

  return asCallResult({
    ok: true,
    timezone: args.timezone ?? timezone,
    slots: wireSlots,
  });
}

// ---------------------------------------------------------------------------
// Stub handlers for the 7 tools landing in later chunks. Registered so the
// tool list is discoverable from day one; each returns a `not_implemented`
// refusal until its chunk lands. Keeps the `.well-known/mcp.json` list
// stable instead of growing tool-by-tool.
// ---------------------------------------------------------------------------

function notImplemented(tool: McpToolName): CallToolResult {
  return asCallResult(
    {
      ok: false,
      reason: "rate_limited", // nearest-fit in every refusal union
      message: `Tool "${tool}" is registered but not yet implemented. Check the deploy notes.`,
    },
    { isError: true }
  );
}

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Wire every MCP tool handler into an `McpServer`. Called once per request
 * in the stateless Streamable-HTTP transport pattern.
 *
 * We register ALL 8 tools (even the not-yet-implemented ones) so the MCP
 * client's tool discovery list is stable across deploys. Incomplete tools
 * return an `isError: true` refusal.
 */
export function registerMcpTools(server: McpServer): void {
  const handlers: Record<McpToolName, (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult> =
    {
      get_meeting_parameters: (args) =>
        handleGetMeetingParameters(
          args as z.infer<typeof getMeetingParametersInput>
        ),
      get_availability: (args) =>
        handleGetAvailability(args as z.infer<typeof getAvailabilityInput>),
      get_session_status: () => notImplemented("get_session_status"),
      post_message: () => notImplemented("post_message"),
      propose_parameters: () => notImplemented("propose_parameters"),
      propose_lock: () => notImplemented("propose_lock"),
      cancel_meeting: () => notImplemented("cancel_meeting"),
      reschedule_meeting: () => notImplemented("reschedule_meeting"),
    };

  for (const name of Object.keys(MCP_TOOLS) as McpToolName[]) {
    const tool = MCP_TOOLS[name];
    // `.shape` turns z.object({...}).strict() back into a ZodRawShape the
    // SDK's registerTool accepts directly. `.strict()` is preserved.
    // For unions/primitives at the root we'd need a different path; all
    // 8 tool inputs are object roots (enforced by the smoke tests).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputShape = (tool.input as any).shape as Record<string, any>;
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: inputShape,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handlers[name] as any
    );
  }
}
