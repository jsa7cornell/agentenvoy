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
import { confirmBooking } from "@/lib/confirm-pipeline";
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
  const rules = (link.rules ?? {}) as LinkRules;
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
  const rules = (link.rules ?? {}) as LinkRules;

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
  const rules = (link.rules ?? {}) as LinkRules;

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
// Handler: cancel_meeting  (blocked — pipeline extraction pending)
// ---------------------------------------------------------------------------

/**
 * Returns an explicit refusal until `cancel-pipeline.ts` lands (per the
 * parent proposal's extraction sequence). Kept discoverable so agents can
 * parse the tools/list response today and know this name reserves the slot.
 */
export async function handleCancelMeeting(
  _args: z.infer<typeof cancelMeetingInput> // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<CallToolResult> {
  return asCallResult(
    {
      ok: false,
      reason: "session_terminal",
      message:
        "cancel_meeting is not yet implemented. Blocked on cancel-pipeline extraction (parent proposal §2).",
    },
    { isError: true }
  );
}

// ---------------------------------------------------------------------------
// Handler: reschedule_meeting  (blocked — pipeline extraction pending)
// ---------------------------------------------------------------------------

export async function handleRescheduleMeeting(
  _args: z.infer<typeof rescheduleMeetingInput> // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<CallToolResult> {
  return asCallResult(
    {
      ok: false,
      reason: "session_terminal",
      message:
        "reschedule_meeting is not yet implemented. Blocked on reschedule-pipeline extraction (parent proposal §2).",
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
