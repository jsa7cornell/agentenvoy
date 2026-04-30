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
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getUserTimezone } from "@/lib/timezone";
import {
  applyEventOverrides,
  getTier,
  filterByDuration,
  deriveTimingAnchor,
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
import {
  authorizeMcpCall,
  parseMeetingUrl,
  resolveLink,
  type AuthorizeResult,
} from "@/lib/mcp/auth";
import { resolveParameters } from "@/lib/mcp/parameter-resolver";
import { confirmBooking } from "@/lib/confirm-pipeline";
import { cancelSession } from "@/lib/cancel-pipeline";
import { handleLockActivityLocation as lockActivityLocationCore } from "@/agent/actions";
import { writeMcpCallLog } from "@/lib/mcp/call-log";
import {
  MCP_TOOLS,
  type McpToolName,
  getMeetingParametersInput,
  getAvailabilityInput,
  getSessionStatusInput,
  postMessageInput,
  proposeParametersInput,
  proposeLockInput,
  cancelMeetingInput,
  rescheduleMeetingInput,
  lockActivityLocationInput,
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

  const rules = (link.parameters ?? {}) as LinkParameters;
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
    rules: buildRulesPassthrough(rules),
  });
}

/**
 * Build the wire-shape `rules` passthrough from a link's stored parameters.
 * Shared between `get_meeting_parameters` (top-level rules object) and
 * `get_availability` (optional rules field — Town agent feedback #4 fold,
 * 2026-04-30 stabilization-package follow-up).
 *
 * Keeping this factored prevents the two surfaces from drifting on which
 * fields they advertise. SPEC invariant #9.
 */
export function buildRulesPassthrough(rules: LinkParameters): Record<string, unknown> {
  const r = rules as Record<string, unknown>;
  const isVip = typeof r.isVip === "boolean" ? r.isVip : undefined;
  const anchor = deriveTimingAnchor(rules.timingLabel);
  const timingPreference =
    rules.timingLabel !== undefined ? { anchor } : undefined;
  const gpWindow = (r.guestPicks as { window?: unknown } | undefined)?.window;
  const guestPicksWindow =
    gpWindow &&
    typeof (gpWindow as { startHour?: unknown }).startHour === "number" &&
    typeof (gpWindow as { endHour?: unknown }).endHour === "number"
      ? {
          startHour: (gpWindow as { startHour: number }).startHour,
          endHour: (gpWindow as { endHour: number }).endHour,
        }
      : undefined;
  return {
    ...(rules.activity ? { activity: rules.activity } : {}),
    ...(rules.activityIcon ? { activityIcon: rules.activityIcon } : {}),
    ...(Array.isArray(rules.activityOptions) && (rules.activityOptions as string[]).length > 1
      ? { activityOptions: rules.activityOptions }
      : {}),
    ...(rules.timingLabel ? { timingLabel: rules.timingLabel } : {}),
    ...(isVip !== undefined ? { isVip } : {}),
    ...(timingPreference ? { timingPreference } : {}),
    ...(guestPicksWindow ? { guestPicksWindow } : {}),
  };
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
  const rules = (link.parameters ?? {}) as LinkParameters;

  // Load the host's preferences for tz + structuredRules (office hours).
  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { preferences: true },
  });
  const prefs = (host?.preferences ?? {}) as Record<string, unknown>;
  const timezone = getUserTimezone(prefs);

  // Resolve the parameters envelope alongside slots — Town agent feedback #4
  // (2026-04-30 stabilization fold). For the 90% case where parameters are
  // locked, this collapses the three-call (get_meeting_parameters →
  // get_availability → propose_lock) flow to two calls. Agents that need
  // to negotiate parameters can still call get_meeting_parameters separately.
  const hostPreferences = (host?.preferences ?? null) as UserPreferences | null;
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

  // Pull the host's global scored schedule.
  const schedule = await getOrComputeSchedule(link.userId);
  if (!schedule.connected) {
    return asCallResult({ ok: true, timezone, slots: [], parameters, rules: rulesPassthrough });
  }

  // Event-level overrides from link rules (dateRange, preferredDays, etc).
  let slots: ScoredSlot[] = applyEventOverrides(schedule.slots, rules, timezone);

  // Office-hours transform if the link was spawned from a rule.
  if (link.recurringWindowId) {
    const explicit = prefs.explicit as Record<string, unknown> | undefined;
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

  // Sort best-first (lowest score, ties broken by earliest start) BEFORE
  // applying limit, so the truncated set is the most-preferred slots not
  // an arbitrary chronological prefix.
  slots.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });

  // Cap at caller's limit (default 20). Stabilization-package §3 Group C —
  // Town agent feedback showed ~80 slots produces decision fatigue.
  const limit = args.limit ?? 20;
  if (slots.length > limit) {
    slots = slots.slice(0, limit);
  }

  // Format `localStart` in the host's timezone — saves agents UTC math.
  const localFmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

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
    // `preferred` mirrors the web greeting's `isPreferred` predicate
    // (`score <= -1`) so guest agents get the same star-worthiness signal
    // without hardcoding the threshold. SPEC invariant #9.
    const preferred = s.score <= -1;
    // sv-SE locale produces "YYYY-MM-DD HH:MM:SS" — replace the space with T
    // for ISO-like shape, no offset suffix (the timezone is implicit per the
    // top-level `timezone` field on the response).
    const localStart = localFmt.format(new Date(s.start)).replace(" ", "T");
    return {
      start: s.start,
      end: s.end,
      localStart,
      score: s.score,
      ...(wireTier ? { tier: wireTier } : {}),
      ...(preferred ? { preferred: true } : {}),
    };
  });

  return asCallResult({
    ok: true,
    timezone: args.timezone ?? timezone,
    slots: wireSlots,
    parameters,
    rules: rulesPassthrough,
  });
}

// ---------------------------------------------------------------------------
// Handler: get_session_status
// ---------------------------------------------------------------------------

/** Map the DB session status string onto the wire enum. "escalated" is an
 *  internal detour; externally it's still an active negotiation. Unknown
 *  values fall back to "active" rather than 500'ing the call. */
function mapSessionStatus(
  s: string
): "active" | "agreed" | "cancelled" | "rescheduled" | "expired" {
  switch (s) {
    case "agreed":
    case "cancelled":
    case "rescheduled":
    case "expired":
      return s;
    case "escalated":
    case "active":
    default:
      return "active";
  }
}

export async function handleGetSessionStatus(
  args: z.infer<typeof getSessionStatusInput>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "get_session_status",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;

  // Session lookup. With explicit sessionId, the session must belong to this
  // link (defense against cross-link id guessing). Without one, pick the most
  // recent session on this link.
  const session = args.sessionId
    ? await prisma.negotiationSession.findFirst({
        where: { id: args.sessionId, linkId: link.id },
        select: {
          id: true,
          status: true,
          agreedTime: true,
        },
      })
    : await prisma.negotiationSession.findFirst({
        where: { linkId: link.id },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          status: true,
          agreedTime: true,
        },
      });

  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "No negotiation session exists for this meeting link.",
    });
  }

  // Live consent requests on this session (or link-level when unscoped).
  const consentRows = await prisma.consentRequest.findMany({
    where: {
      linkId: link.id,
      sessionId: session.id,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      field: true,
      appliedValue: true,
      expiresAt: true,
    },
  });

  return asCallResult({
    ok: true,
    status: mapSessionStatus(session.status),
    sessionId: session.id,
    agreedTime: session.agreedTime ? session.agreedTime.toISOString() : null,
    // Reschedule history isn't persisted yet (reschedule-pipeline chunk);
    // returning an empty array keeps the wire shape stable so agents don't
    // have to branch on presence vs. absence once it lands.
    rescheduleHistory: [],
    pendingConsentRequests: consentRows.map((c) => ({
      id: c.id,
      field: c.field,
      proposedValue: c.appliedValue,
      expiresAt: c.expiresAt.toISOString(),
    })),
  });
}

// ---------------------------------------------------------------------------
// Shared: resolve the target NegotiationSession for a write call.
// ---------------------------------------------------------------------------

type ResolvedSession = {
  id: string;
  linkId: string;
  hostId: string;
  status: string;
};

/**
 * Find (or mint) the session this write should act on.
 *
 * The MCP caller may pass `sessionId` explicitly (bounded to the link) or
 * omit it — in which case we look for the most-recent session on this link.
 * When `bootstrap` is true AND no session exists, we mint one with
 * defaults derived from the link rules. This is the path an external agent
 * takes when it's the first to touch a fresh link.
 */
async function resolveSession(args: {
  linkId: string;
  hostId: string;
  sessionId?: string | null;
  bootstrap?: { format?: string; duration?: number; title?: string };
}): Promise<ResolvedSession | null> {
  if (args.sessionId) {
    const s = await prisma.negotiationSession.findFirst({
      where: { id: args.sessionId, linkId: args.linkId },
      select: { id: true, linkId: true, hostId: true, status: true },
    });
    return s ?? null;
  }
  const existing = await prisma.negotiationSession.findFirst({
    where: { linkId: args.linkId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, linkId: true, hostId: true, status: true },
  });
  if (existing) return existing;
  if (!args.bootstrap) return null;
  const created = await prisma.negotiationSession.create({
    data: {
      linkId: args.linkId,
      hostId: args.hostId,
      status: "active",
      title: args.bootstrap.title,
      format: args.bootstrap.format,
      duration: args.bootstrap.duration,
    },
    select: { id: true, linkId: true, hostId: true, status: true },
  });
  return created;
}

// ---------------------------------------------------------------------------
// Handler: post_message
// ---------------------------------------------------------------------------

/**
 * Persist a message to the deal-room thread on behalf of an external agent.
 *
 * v1 scope: thread-of-record only. The message lands with role="guest" and
 * `metadata.clientType = "external_agent"` so the UI can badge it. The
 * envoy-reply streaming path (via the SDK's notification channel) is a
 * follow-up — the schema already marks `envoyReply` as optional so clients
 * are future-compatible when it lights up.
 */
export async function handlePostMessage(
  args: z.infer<typeof postMessageInput>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "post_message",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;

  // Bootstrap a session on first contact so an external agent can open a
  // thread without a round-trip. Defaults come from link rules.
  const rules = (link.parameters ?? {}) as LinkParameters;
  const session = await resolveSession({
    linkId: link.id,
    hostId: link.userId,
    bootstrap: {
      format: (rules as Record<string, unknown>).format as string | undefined,
      duration: (rules as Record<string, unknown>).duration as number | undefined,
      title: args.clientMeta?.principal?.name
        ? `External agent — ${args.clientMeta.principal.name}`
        : "External agent thread",
    },
  });
  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "Session could not be opened for this link.",
    });
  }

  // Terminal sessions refuse writes — mirrors SPEC §2.4. "agreed" remains
  // writeable so the guest (or their agent) can follow up after booking.
  if (session.status === "cancelled" || session.status === "expired") {
    return asCallResult({
      ok: false,
      reason: "session_terminal",
      message: `Session is ${session.status}; messages are closed.`,
    });
  }

  const metadata: Record<string, unknown> = {
    clientType: args.clientMeta?.clientType ?? "external_agent",
  };
  if (args.clientMeta?.clientName) metadata.clientName = args.clientMeta.clientName;
  if (args.clientMeta?.principal)
    metadata.principal = args.clientMeta.principal;

  const created = await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "guest",
      content: args.text,
      metadata: metadata as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return asCallResult({
    ok: true,
    messageId: created.id,
    sessionId: session.id,
  });
}

// ---------------------------------------------------------------------------
// Handler: propose_parameters
// ---------------------------------------------------------------------------

/**
 * Batch proposal: "I want format=phone, duration=45." For each requested
 * field, check against the parameter-resolver's envelope:
 *   - `locked`                  → reject with `field_locked`
 *   - `allowedValues` bounded   → reject with `value_not_allowed` if outside
 *   - otherwise                 → write onto NegotiationSession and mark accepted
 *
 * v1 scope: format + duration are persisted directly onto the session. The
 * `location` field stays delegated to `propose_lock` / host-envoy consent
 * since there's no per-session `location` column yet.
 *
 * `action: "defer_to_host_envoy"` short-circuits every field to a
 * `deferred_to_host_envoy` result — the actual consent-request wiring lives
 * in the ConsentRequest table and will be populated by the host envoy
 * follow-up chunk.
 */
export async function handleProposeParameters(
  args: z.infer<typeof proposeParametersInput>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "propose_parameters",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;
  const rules = (link.parameters ?? {}) as LinkParameters;

  const session = await resolveSession({
    linkId: link.id,
    hostId: link.userId,
    sessionId: args.sessionId,
    bootstrap: args.sessionId
      ? undefined
      : {
          format: (rules as Record<string, unknown>).format as string | undefined,
          duration: (rules as Record<string, unknown>).duration as number | undefined,
          title: "External agent thread",
        },
  });
  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "Session not found for this link.",
    });
  }
  if (session.status === "cancelled" || session.status === "expired") {
    return asCallResult({
      ok: false,
      reason: "session_terminal",
      message: `Session is ${session.status}; proposals are closed.`,
    });
  }

  // Load host preferences for the resolver fallback chain.
  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { preferences: true },
  });
  const hostPreferences = (host?.preferences ?? null) as UserPreferences | null;
  const hostTimezone = getUserTimezone(
    hostPreferences as Record<string, unknown> | null
  );
  const compiledRules =
    ((hostPreferences?.explicit as Record<string, unknown> | undefined)
      ?.compiled as CompiledRules | undefined) ?? null;
  const envelopes = resolveParameters({
    rules,
    hostPreferences,
    hostTimezone,
    compiledRules,
  });

  const proposal = args.proposal;
  const deferred = args.action === "defer_to_host_envoy";
  const accepted: Record<string, unknown> = {};
  const results: Array<Record<string, unknown>> = [];

  for (const field of ["format", "duration", "location"] as const) {
    if (!(field in proposal)) continue;
    const value = (proposal as Record<string, unknown>)[field];

    if (deferred) {
      results.push({
        field,
        accepted: false,
        reason: "deferred_to_host_envoy",
        decidedBy: "host_envoy",
      });
      continue;
    }

    const env = (envelopes as unknown as Record<string, unknown>)[field] as
      | { mutability: string; allowedValues?: unknown[] }
      | undefined;

    if (env?.mutability === "locked") {
      results.push({
        field,
        accepted: false,
        reason: "field_locked",
      });
      continue;
    }
    if (
      env?.allowedValues &&
      env.allowedValues.length > 0 &&
      !env.allowedValues.includes(value)
    ) {
      results.push({
        field,
        accepted: false,
        reason: "value_not_allowed",
      });
      continue;
    }

    accepted[field] = value;
    results.push({
      field,
      accepted: true,
      reason: "accepted",
      appliedValue: value,
      decidedBy: "guest",
    });
  }

  // Persist accepted fields. Location stays deferred — no per-session column.
  const updateData: Record<string, unknown> = {};
  if (typeof accepted.format === "string") updateData.format = accepted.format;
  if (typeof accepted.duration === "number")
    updateData.duration = accepted.duration;
  if (Object.keys(updateData).length > 0) {
    await prisma.negotiationSession.update({
      where: { id: session.id },
      data: updateData,
    });
  }

  return asCallResult({
    ok: true,
    sessionId: session.id,
    results,
    decidedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Handler: propose_lock (the handshake)
// ---------------------------------------------------------------------------

/**
 * The booking handshake. Validates, bootstraps a session if needed, calls
 * `confirmBooking()` — the same pipeline the HTTP confirm route uses — and
 * maps the `ConfirmResult` onto the wire envelope.
 *
 * Session bootstrap: if the caller omits `sessionId` and no session exists
 * on this link, we mint one with minimal defaults before calling the
 * pipeline. The alternative (refusing with `session_not_found`) would force
 * every external agent to call `post_message` first just to materialize a
 * session, which is silly for pure-booking flows.
 *
 * Overrides precedence: slot.durationMinutes > overrides.* > session
 * defaults > link rules. Mirrored inside `confirmBooking` — we just pass
 * through what the caller specified.
 */
export async function handleProposeLock(
  args: z.infer<typeof proposeLockInput>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "propose_lock",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;
  const rules = (link.parameters ?? {}) as LinkParameters;

  // Resolve or bootstrap. For propose_lock, bootstrap is always on — the
  // whole point is to open-and-commit in a single call when possible.
  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { name: true },
  });
  const session = await resolveSession({
    linkId: link.id,
    hostId: link.userId,
    sessionId: args.sessionId,
    bootstrap: {
      format:
        args.overrides?.format ??
        ((rules as Record<string, unknown>).format as string | undefined),
      duration:
        args.slot.durationMinutes ??
        ((rules as Record<string, unknown>).duration as number | undefined),
      title: `${host?.name ?? "Host"} & ${args.guest.name}`,
    },
  });
  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "Session could not be resolved for this link.",
    });
  }

  // Persist guest info before the pipeline runs so the confirm card has it
  // (the pipeline reads session.guestEmail/guestName when the body values
  // are null).
  await prisma.negotiationSession.update({
    where: { id: session.id },
    data: {
      guestEmail: args.guest.email,
      guestName: args.guest.name,
      ...(args.guest.wantsReminder !== undefined
        ? { wantsReminder: args.guest.wantsReminder }
        : {}),
    },
  });

  const duration =
    args.slot.durationMinutes ??
    ((rules as Record<string, unknown>).duration as number | undefined) ??
    30;

  const result = await confirmBooking({
    sessionId: session.id,
    dateTime: args.slot.start,
    duration,
    format: args.overrides?.format ?? undefined,
    location: args.overrides?.location ?? null,
    guestEmail: args.guest.email,
    guestName: args.guest.name,
    wantsReminder: args.guest.wantsReminder,
    guestNote: args.guest.note ?? null,
    userAgent: null,
  });

  if (!result.ok) {
    // Map ConfirmResult refusal reasons to the schema's propose_lock enum.
    // They're 1:1 by design except validation_failed which stays as-is.
    return asCallResult({
      ok: false,
      reason: result.reason,
      message: result.message,
    });
  }

  return asCallResult({
    ok: true,
    sessionId: session.id,
    status: "confirmed",
    dateTime: result.dateTime,
    duration: result.duration,
    format: result.format,
    location: result.location,
    ...(result.meetLink ? { meetLink: result.meetLink } : {}),
    ...(result.eventLink ? { eventLink: result.eventLink } : {}),
    ...(result.idempotent ? { idempotent: true } : {}),
    ...(result.warnings && result.warnings.length > 0
      ? { warnings: result.warnings }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Handler: cancel_meeting
// ---------------------------------------------------------------------------

/**
 * Cancel a confirmed meeting on behalf of an external agent.
 *
 * Thin wrapper over `cancelSession()` from `@/lib/cancel-pipeline`. The
 * pipeline owns the cascade (Google delete, hold release, schedule cache
 * invalidation, state flip, system-message timeline indicator); this handler
 * layers the MCP-specific concerns (link auth, business gate, refusal-reason
 * mapping).
 *
 * Business gate: matches `/api/negotiate/cancel/route.ts` — only `agreed`
 * sessions can be cancelled. Sessions in `active`/`pending` states should be
 * archived, not cancelled. Sessions already in `cancelled` are idempotent
 * (return `ok: true, idempotent: true`).
 *
 * Initiator is recorded as `"agent"` so the deal-room timeline + statusLabel
 * reflect the external-agent provenance. The `clientMeta.principal.name`, if
 * provided, is used as the `initiatorName` so the timeline shows e.g.
 * "Meeting cancelled by Amy" rather than "Meeting cancelled by host."
 */
export async function handleCancelMeeting(
  args: z.infer<typeof cancelMeetingInput>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "cancel_meeting",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;

  const session = await resolveSession({
    linkId: link.id,
    hostId: link.userId,
    sessionId: args.sessionId,
  });
  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "No session found for this link.",
    });
  }

  // Idempotency: already-cancelled sessions return ok:true, idempotent:true
  // without re-running the cascade. Mirrors cancelSession()'s own no-op path.
  if (session.status === "cancelled") {
    return asCallResult({
      ok: true,
      sessionId: session.id,
      status: "cancelled",
      idempotent: true,
    });
  }

  // Business gate (mirrors /api/negotiate/cancel): only confirmed meetings
  // are cancellable via this surface. Active/pending sessions don't have a
  // calendar event to delete; they should be archived instead. Terminal
  // states other than "cancelled" (expired, rescheduled, escalated) are not
  // cancellable.
  if (session.status !== "agreed") {
    return asCallResult({
      ok: false,
      reason:
        session.status === "active" ? "session_not_agreed" : "session_terminal",
      message:
        session.status === "active"
          ? "Only confirmed meetings can be cancelled."
          : `Session is in terminal state '${session.status}' and cannot be cancelled.`,
    });
  }

  const initiatorName =
    args.clientMeta?.principal?.name ?? null;

  const result = await cancelSession({
    sessionId: session.id,
    hostId: link.userId,
    initiator: "agent",
    initiatorName,
    note: args.reason ?? null,
    notifyAttendees: args.notifyHost ?? true,
  });

  if (!result.ok) {
    // cancelSession() returns a string `error`; map common shapes back to
    // the schema's refusal enum. "Session not found" is unlikely (we just
    // resolved), "Unauthorized" can't happen (link.userId == session.hostId
    // by resolveSession() construction), so the residual is a generic
    // pipeline failure — surface as session_terminal.
    return asCallResult({
      ok: false,
      reason: "session_terminal",
      message: result.error ?? "Cancel failed.",
    });
  }

  return asCallResult({
    ok: true,
    sessionId: session.id,
    status: "cancelled",
    ...(result.changed === false ? { idempotent: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// Handler: reschedule_meeting  (stub — awaiting reschedule-pipeline.ts)
// ---------------------------------------------------------------------------

/**
 * Stub. Returns `tool_not_implemented` until the proper patch-in-place
 * implementation lands. The HTTP route `/api/negotiate/reschedule` does
 * cancel-and-rebook (two notifications, new iCalUID); the MCP wire's
 * intended behavior per `app/src/lib/mcp/SPEC.md` §11.2 is in-place
 * `calendar.events.patch` (one notification, preserved iCalUID, appends to
 * `rescheduleHistory`). The semantic gap + schema additions
 * (`supersededByRescheduleId`, `finalizesAt`, `rescheduleHistory`) make
 * this proposal-required work.
 *
 * Proposal: `proposals/2026-04-29_mcp-reschedule-meeting-patch-in-place.md`.
 * Wishlist: #42 (Agent Platform).
 *
 * --- Stub discipline ---
 * Any tool advertised in `MCP_TOOLS` but not yet wired to a real handler
 * MUST return `reason: "tool_not_implemented"`. Do NOT reuse a state-specific
 * reason like `session_terminal` — agents reading the wire must be able to
 * distinguish "this server doesn't support this yet" from "your session is
 * closed." See the `tool_not_implemented` enum value in
 * `schemas.ts#rescheduleMeetingOutput` for the canonical comment.
 */
export async function handleRescheduleMeeting(
  _args: z.infer<typeof rescheduleMeetingInput> // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<CallToolResult> {
  return asCallResult(
    {
      ok: false,
      reason: "tool_not_implemented",
      // Guest-safe: never leak internal repo paths or proposal filenames in
      // wire-visible messages. Agents that hit this fall back to
      // cancel + rebook via cancel_meeting + propose_lock.
      message:
        "This tool is not currently available. Cancel and rebook to achieve the same result.",
    },
    { isError: true }
  );
}

// ---------------------------------------------------------------------------
// Handler: lock_activity_location
// ---------------------------------------------------------------------------

/**
 * Lock activity and/or location on behalf of an external agent representing
 * a guest. Mirrors the host-Envoy dialog action of the same name; the
 * server-side implementation is shared (`@/agent/actions#handleLockActivityLocation`)
 * so host and guest paths can never drift.
 *
 * Validation: at least one of `activity` or `location` MUST be provided —
 * enforced here rather than in the schema so the SDK's tool-registration
 * path can extract a ZodRawShape via `.shape`. See `schemas.ts` note.
 *
 * Auth: link-scoped (anyone with the meeting URL can call). The shared
 * core handler accepts `userId` (the host) and is called with `link.userId`
 * here — the auth check inside the core (`session.hostId !== userId`)
 * passes by construction since `link.userId` is `session.hostId` for any
 * session under that link.
 */
export async function handleLockActivityLocation(
  args: z.infer<typeof lockActivityLocationInput>
): Promise<CallToolResult> {
  // 1. Validate: at least one of activity/location.
  if (!args.activity && !args.location) {
    return asCallResult({
      ok: false,
      reason: "validation_failed",
      message:
        "At least one of `activity` or `location` must be provided.",
    });
  }

  // 2. Auth boundary.
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "lock_activity_location",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;

  // 3. Resolve session.
  const session = await resolveSession({
    linkId: link.id,
    hostId: link.userId,
    sessionId: args.sessionId,
  });
  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "No session found for this link.",
    });
  }

  // 4. Delegate to the shared core handler.
  const result = await lockActivityLocationCore(
    {
      sessionId: session.id,
      ...(args.activity ? { activity: args.activity } : {}),
      ...(args.location ? { location: args.location } : {}),
    },
    link.userId,
    session.id
  );

  if (!result.success) {
    // Map the core handler's free-text error message back to the schema's
    // refusal enum. Three known shapes:
    //   - "Session is already confirmed"            → session_terminal
    //   - "Format upgrade not allowed: ..."         → format_upgrade_blocked
    //   - "Not authorized for this session"         → session_not_found
    //     (shouldn't happen — link.userId == session.hostId by construction)
    //   - anything else                             → validation_failed
    const msg = result.message ?? "Lock failed.";
    let reason:
      | "session_terminal"
      | "format_upgrade_blocked"
      | "session_not_found"
      | "validation_failed" = "validation_failed";
    if (msg.includes("already confirmed")) reason = "session_terminal";
    else if (msg.includes("Format upgrade not allowed"))
      reason = "format_upgrade_blocked";
    else if (msg.includes("Not authorized")) reason = "session_not_found";

    return asCallResult({ ok: false, reason, message: msg });
  }

  const data = (result.data ?? {}) as Record<string, unknown>;
  return asCallResult({
    ok: true,
    sessionId: session.id,
    locked: {
      activity: (data.negotiatedActivity as string | null) ?? null,
      location: (data.negotiatedLocation as string | null) ?? null,
      format: (data.negotiatedFormat as string | null) ?? null,
    },
    lockedBy: "guest" as const,
  });
}

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Wire every MCP tool handler into an `McpServer`. Called once per request
 * in the stateless Streamable-HTTP transport pattern.
 *
 * We register ALL tools in the `MCP_TOOLS` registry (even not-yet-implemented
 * stubs) so the MCP client's tool discovery list is stable across deploys.
 * Incomplete tools return an `isError: true` refusal with `reason:
 * "tool_not_implemented"` (see schemas.ts canonical comment).
 */
/**
 * Wrap a handler so every call — ok or refusal — lands in `MCPCallLog`.
 *
 * The writer is fire-and-forget (non-blocking): we build the ctx synchronously
 * after the handler returns, kick off the insert, and return the tool result
 * immediately. If the writer throws, it already logs to console — we don't
 * let observability sit on the critical path.
 *
 * `linkId` is re-resolved from `meetingUrl` here. This costs an extra
 * findUnique per call; the alternative (threading the auth result out of
 * every handler) touches eight call sites for marginal gain. The log write
 * itself is off the hot path, so the duplicate read is fine.
 */
function withCallLogging(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult,
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    const started = Date.now();
    const result = await handler(args);
    const response = (result.structuredContent ?? {}) as Record<string, unknown>;
    const latencyMs = Date.now() - started;
    const meetingUrl = args.meetingUrl as string | undefined;
    const clientMeta = args.clientMeta as
      | {
          clientName?: string;
          clientType?: string;
          principal?: { name?: string; email?: string };
        }
      | undefined;

    // Resolve linkId lazily in a floating promise — never block the response.
    void (async () => {
      try {
        if (!meetingUrl) return;
        const parsed = parseMeetingUrl(meetingUrl);
        if (!parsed.ok) return;
        const resolved = await resolveLink(parsed);
        if (!resolved.ok) return;
        await writeMcpCallLog({
          tool: name,
          linkId: resolved.link.id,
          sessionId: (response.sessionId as string | undefined) ?? null,
          clientMeta,
          requestArgs: args,
          response,
          latencyMs,
        });
      } catch (e) {
        console.error("[mcp/tools] call-log wrapper failed:", e);
      }
    })();

    return result;
  };
}

export function registerMcpTools(server: McpServer): void {
  const handlers: Record<McpToolName, (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult> =
    {
      get_meeting_parameters: (args) =>
        handleGetMeetingParameters(
          args as z.infer<typeof getMeetingParametersInput>
        ),
      get_availability: (args) =>
        handleGetAvailability(args as z.infer<typeof getAvailabilityInput>),
      get_session_status: (args) =>
        handleGetSessionStatus(args as z.infer<typeof getSessionStatusInput>),
      post_message: (args) =>
        handlePostMessage(args as z.infer<typeof postMessageInput>),
      propose_parameters: (args) =>
        handleProposeParameters(
          args as z.infer<typeof proposeParametersInput>
        ),
      propose_lock: (args) =>
        handleProposeLock(args as z.infer<typeof proposeLockInput>),
      cancel_meeting: (args) =>
        handleCancelMeeting(args as z.infer<typeof cancelMeetingInput>),
      reschedule_meeting: (args) =>
        handleRescheduleMeeting(
          args as z.infer<typeof rescheduleMeetingInput>
        ),
      lock_activity_location: (args) =>
        handleLockActivityLocation(
          args as z.infer<typeof lockActivityLocationInput>
        ),
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
      withCallLogging(name, handlers[name]) as any
    );
  }
}
