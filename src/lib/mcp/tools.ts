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
import { getUserTimezone, formatIsoWithOffset } from "@/lib/timezone";
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
  compileBookableLinks,
  getBusinessHoursWindow,
  type AvailabilityRule,
} from "@/lib/availability-rules";
import {
  applyBookableWindow,
  type ConfirmedBooking,
} from "@/lib/bookable-links";
import {
  authorizeMcpCall,
  parseMeetingUrl,
  resolveLink,
  type AuthorizeResult,
} from "@/lib/mcp/auth";
import { resolveParameters } from "@/lib/mcp/parameter-resolver";
import { getLinkPosture } from "@/lib/links/posture";
import { confirmBooking } from "@/lib/confirm-pipeline";
import { cancelSession } from "@/lib/cancel-pipeline";
import { rescheduleSession } from "@/lib/reschedule-pipeline";
import {
  deriveEmittedScore,
  deriveEmittedPreferred,
} from "@/lib/scoring-emit";
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
  getTipInputSchema,
  getEventSummaryInputSchema,
} from "@/lib/mcp/schemas";
import { renderTip } from "@/lib/meeting-tip/render";
import { buildTipInput } from "@/lib/meeting-tip/build-input";
import {
  applyOccurrenceOverride,
  resolveNextUpcomingOccurrence,
} from "@/lib/occurrence-override";
import { readRecurrence } from "@/lib/recurrence";
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

  // V1.5: resolve link posture for duration/location defaults. Graceful
  // fallback to null when backfill hasn't populated variance posture yet.
  let linkPosture: import("@/lib/links/posture").ResolvedPosture | null = null;
  try {
    linkPosture = getLinkPosture(link, { preferences: hostPreferences });
  } catch { /* variance link missing fields — use hostPreferences fallback */ }

  const parameters = resolveParameters({
    rules,
    hostPreferences,
    hostTimezone,
    slotStart,
    compiledRules,
    posture: linkPosture,
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
    select: { preferences: true, name: true, email: true },
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

  // V1.5: per-link posture for resolver defaults + per-link schedule scoring.
  let availPosture: import("@/lib/links/posture").ResolvedPosture | null = null;
  try {
    availPosture = getLinkPosture(link, { preferences: hostPreferences });
  } catch { /* variance link missing fields — use hostPreferences fallback */ }

  const parameters = resolveParameters({
    rules,
    hostPreferences,
    hostTimezone: timezone,
    compiledRules,
    posture: availPosture,
  });
  const rulesPassthrough = buildRulesPassthrough(rules);

  // Pull the host's scored schedule, using link-level posture for variance links.
  const schedule = await getOrComputeSchedule(link.userId, { link });
  const hostName = host?.name ?? "the host";
  const hostContact = host?.email ? `${hostName} at ${host.email}` : hostName;
  if (!schedule.connected) {
    return asCallResult({ ok: true, timezone, slots: [], slotsThrough: null, parameters, rules: rulesPassthrough, hint: `No times are currently available. Email ${hostContact} directly to request a time.` });
  }

  // Event-level overrides from link rules (dateRange, preferredDays, etc).
  let slots: ScoredSlot[] = applyEventOverrides(schedule.slots, rules, timezone);

  // Bookable-link transform if the link was spawned from a rule.
  if (link.recurringWindowId) {
    const explicit = prefs.explicit as Record<string, unknown> | undefined;
    const allRules =
      (explicit?.structuredRules as AvailabilityRule[] | undefined) ?? [];
    const compiledLinks = compileBookableLinks(allRules, getBusinessHoursWindow(prefs as Record<string, unknown>));
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
      slots = applyBookableWindow({
        rule: compiled,
        slots,
        timezone,
        confirmedBookings,
      });
    }
  }

  // Score filter — mirrors slots-route. Exclusive overrides win; VIP links
  // permit protected-band stretches; everyone else gets score ≤ 1.
  //
  // IMPORTANT (Round 2 MCP-N3 of the 2026-05-01 event-availability proposal):
  // these filters read the UNMUTATED host-stable `s.score` from `scoreSlot`.
  // The wire-emit integer is derived per-slot at the wire-emit step below
  // (`deriveEmittedScore`) and does NOT feed back into this filter — same
  // host-stable score in, derived integer out at emit time only.
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

  // Guest-supplied busy windows — subtract before sort/limit so the
  // caller gets a pre-filtered list without a local subtract step.
  if (args.busyWindows?.length) {
    const busy = args.busyWindows.map((w) => ({
      start: new Date(w.start).getTime(),
      end: new Date(w.end).getTime(),
    }));
    slots = slots.filter((s) => {
      const sStart = new Date(s.start).getTime();
      const sEnd = new Date(s.end).getTime();
      return !busy.some((w) => sStart < w.end && sEnd > w.start);
    });
  }

  // Compute slotsThrough before the limit truncation — it reflects the
  // furthest date offered, not just the furthest slot returned.
  const dateFmtHost = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const slotsThrough =
    slots.length > 0
      ? slots.reduce((latest, s) => {
          const d = dateFmtHost.format(new Date(s.start));
          return d > latest ? d : latest;
        }, "0000-00-00")
      : null;

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

  // Emit wire shape. Map "first-offer" (internal) → "first_offer" (schema).
  // localStart is full ISO 8601 with TZ offset (e.g., "2026-05-05T09:00:00-07:00").
  //
  // Score + preferred derivation routed through `scoring-emit.ts` (the
  // single source of truth for wire-emit derivation per the 2026-05-01
  // event-availability proposal). This handles the new three-band model:
  // calendar-availability per-host stable, event-availability per-link
  // (expand/restrict), preferred per-link (decoration only). The host-stable
  // `s.score` from `scoreSlot` is read by the band filters above (lines
  // ~315-323) and is NOT mutated; the wire-emit integer + boolean below
  // are derived per-call.
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
    const emittedScore = deriveEmittedScore(s, rules, timezone);
    const preferred = deriveEmittedPreferred(s, rules, timezone);
    const localStart = formatIsoWithOffset(new Date(s.start), timezone);
    return {
      start: s.start,
      end: s.end,
      localStart,
      score: emittedScore,
      ...(wireTier ? { tier: wireTier } : {}),
      ...(preferred ? { preferred: true } : {}),
    };
  });

  return asCallResult({
    ok: true,
    timezone: args.timezone ?? timezone,
    slots: wireSlots,
    slotsThrough,
    parameters,
    rules: rulesPassthrough,
    ...(wireSlots.length === 0
      ? { hint: `${hostName} didn't offer any times in this window. Email ${hostContact} directly to request a time.` }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Handler: get_session_status
// ---------------------------------------------------------------------------

/** Map the DB session status string onto the wire enum. Several DB statuses
 *  are "internal detours" that collapse to wire "active":
 *  - "escalated" — host-needs-attention, externally still negotiating.
 *  - "proposed" — host has proposed a slot, externally still negotiating.
 *  - "retime_proposed" — host re-timed a previously-confirmed session.
 *    Externally still negotiating; the live event signal is on the wire as
 *    `calendarEventId != null` per SPEC §2.3.2, not as a status enum value.
 *    Mapping to "rescheduled" would be wrong: that wire literal is a
 *    completed-operation success flag from reschedule_meeting, not a
 *    lifecycle state — see proposal 2026-05-04_update-time-action-state-drift
 *    §4b. Unknown values fall back to "active" rather than 500'ing the call. */
export function mapSessionStatus(
  s: string
): "active" | "agreed" | "cancelled" | "rescheduled" | "expired" {
  switch (s) {
    case "agreed":
    case "cancelled":
    case "rescheduled":
    case "expired":
      return s;
    case "escalated":
    case "proposed":
    case "retime_proposed":
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

  // V1.5: per-link posture for resolver defaults.
  let proposePosture: import("@/lib/links/posture").ResolvedPosture | null = null;
  try {
    proposePosture = getLinkPosture(link, { preferences: hostPreferences });
  } catch { /* variance link missing fields — use hostPreferences fallback */ }

  const envelopes = resolveParameters({
    rules,
    hostPreferences,
    hostTimezone,
    compiledRules,
    posture: proposePosture,
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

  // Build the canonical session URL with code so the agent can cancel /
  // reschedule later without digging into the calendar event. Prefer
  // link.code (path-segment form, the canonical mint shape); fall back
  // to bare-vanity URL if somehow missing. NEXTAUTH_URL is the prod base
  // in deploy; localhost is the dev base.
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://agentenvoy.ai";
  const sessionMeetingUrl = link.code
    ? `${baseUrl}/meet/${link.slug}/${link.code}`
    : `${baseUrl}/meet/${link.slug}`;

  return asCallResult({
    ok: true,
    sessionId: session.id,
    meetingUrl: sessionMeetingUrl,
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

  // 2026-05-14 — Recurring-series occurrence path (proposal §3.5.1).
  // When the link is recurring, route to applyOccurrenceOverride rather than
  // cancelling the whole session. "Cancel this" on a recurring link means
  // "cancel the next upcoming occurrence" by default; supply
  // occurrence.originalStartAt to target a specific instance.
  const linkRecurrenceJson = (link as { recurrence?: Prisma.JsonValue | null }).recurrence ?? null;
  const linkRecurrence = readRecurrence(linkRecurrenceJson);
  if (linkRecurrence) {
    const rawOriginalStartAt = args.occurrence?.originalStartAt
      ?? resolveNextUpcomingOccurrence(linkRecurrenceJson)?.toISOString()
      ?? null;
    if (!rawOriginalStartAt) {
      return asCallResult({
        ok: false,
        reason: "session_not_found",
        message:
          "This is a recurring link whose first slot hasn't been picked yet. Supply occurrence.originalStartAt to target a specific instance.",
      });
    }
    const originalStartAt = new Date(rawOriginalStartAt);
    const occRow = await applyOccurrenceOverride({
      linkId: link.id,
      originalStartAt,
      status: "cancelled",
      divergedBy: "host",
      counterpartyAck: "accepted",
      reason: args.reason ?? null,
    });
    // Best-effort anchor session lookup for the response sessionId field.
    const anchorSession = await prisma.negotiationSession.findFirst({
      where: { linkId: link.id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return asCallResult({
      ok: true,
      sessionId: anchorSession?.id ?? link.id,
      status: "cancelled",
      occurrence: {
        id: occRow.id,
        originalStartAt: occRow.originalStartAt.toISOString(),
      },
    });
  }

  // When sessionId is supplied, look it up by sessionId DIRECTLY — not
  // constrained to the auth'd link. This is the cancel-flow ergonomic
  // fix (2026-05-01, friend's Claude FEEDBACK.md): an agent that booked
  // through a bare-vanity URL (/meet/<slug>) gets back a sessionId from
  // propose_lock; that session is often associated with a *different*
  // link row (contextual w/ code) than the bare-vanity primary the auth
  // path resolves to. Constraining by linkId here produced spurious
  // session_not_found.
  //
  // Authorization is preserved by checking session.hostId === link.userId
  // — possessing the bare-vanity URL means you're the host, so any
  // session of yours is yours to cancel. No cross-host leakage.
  let session: { id: string; hostId: string; status: string } | null = null;
  if (args.sessionId) {
    session = await prisma.negotiationSession.findUnique({
      where: { id: args.sessionId },
      select: { id: true, hostId: true, status: true },
    });
    if (session && session.hostId !== link.userId) {
      // Auth'd link belongs to a different host than this session.
      // Don't leak existence — return session_not_found.
      session = null;
    }
  } else {
    // No sessionId — fall back to "latest agreed session on the auth'd
    // link." This is the legacy path; works when bare-vanity URL maps to
    // the same link the booking is on (contextual flows where the agent
    // has the full /meet/<slug>/<code> URL).
    const resolved = await resolveSession({
      linkId: link.id,
      hostId: link.userId,
    });
    session = resolved
      ? { id: resolved.id, hostId: link.userId, status: resolved.status }
      : null;
  }
  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: args.sessionId
        ? "Session id did not resolve, or it belongs to a different host."
        : "No session found for this link. Pass `sessionId` if you have it from a prior `propose_lock`.",
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
// Handler: reschedule_meeting  (live — patch-in-place via reschedule-pipeline.ts)
// ---------------------------------------------------------------------------

/**
 * Reschedule a confirmed session in-place via Google Calendar's `events.patch`.
 * Preserves iCalUID (single update notification, calendar apps update in
 * place). Idempotent on `(sessionId, idempotencyKey)` via RescheduleAttempt.
 *
 * Asymmetry vs. cancel-pipeline (proposal §B1): GCal patch failures
 * BLOCK — return `gcal_patch_failed`, no DB update. A missed-cancel
 * leaves a recoverable ghost event; a missed-reschedule sends people
 * to the wrong time.
 *
 * Proposal: 2026-04-29_mcp-reschedule-meeting-patch-in-place_*_decided-2026-04-30.md
 */
export async function handleRescheduleMeeting(
  args: z.infer<typeof rescheduleMeetingInput>,
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "reschedule_meeting",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;

  // 2026-05-14 — Recurring-series occurrence path (proposal §3.5.1, B2).
  // When the link is recurring AND occurrence.originalStartAt is supplied (or
  // defaults to next-upcoming), reschedule just that occurrence rather than
  // moving the whole session. Time changes set counterpartyAck=null (bilateral
  // per R4); format/location changes auto-ack.
  const linkRecurrenceForReschedule = readRecurrence(
    (link as { recurrence?: unknown }).recurrence ?? null,
  );
  if (linkRecurrenceForReschedule && args.occurrence) {
    const originalStartAt = new Date(args.occurrence.originalStartAt);
    const newStart = new Date(args.newSlot.start);
    // Time changes require bilateral ACK; format/location single-occurrence
    // ops auto-ack (proposal B2 table).
    const isTimeChange = true; // newSlot always carries a time; this path is time-change
    const occRow = await applyOccurrenceOverride({
      linkId: link.id,
      originalStartAt,
      status: "rescheduled",
      divergedBy: "host",
      actualStartAt: newStart,
      ...(args.newSlot.durationMinutes
        ? { actualEndAt: new Date(newStart.getTime() + args.newSlot.durationMinutes * 60_000) }
        : {}),
      ...(args.overrides?.format ? { actualFormat: args.overrides.format } : {}),
      ...(args.overrides?.location !== undefined
        ? { actualLocation: args.overrides.location ?? null }
        : {}),
      counterpartyAck: isTimeChange ? null : "accepted",
      reason: args.reason ?? null,
    });
    const anchorSessionForReschedule = await prisma.negotiationSession.findFirst({
      where: { linkId: link.id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return asCallResult({
      ok: true,
      sessionId: anchorSessionForReschedule?.id ?? link.id,
      status: "rescheduled",
      from: originalStartAt.toISOString(),
      to: newStart.toISOString(),
      occurrence: {
        id: occRow.id,
        originalStartAt: occRow.originalStartAt.toISOString(),
      },
    });
  }

  // Resolve sessionId — either passed explicitly or latest agreed session
  // on this link. Latest-on-link mirrors handleCancelMeeting's resolver.
  const session = args.sessionId
    ? await prisma.negotiationSession.findUnique({
        where: { id: args.sessionId },
        select: { id: true, hostId: true, status: true },
      })
    : await prisma.negotiationSession.findFirst({
        where: { linkId: link.id, status: "agreed" },
        orderBy: { agreedTime: "desc" },
        select: { id: true, hostId: true, status: true },
      });

  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "No matching session for this link.",
    });
  }
  if (session.hostId !== link.userId) {
    // Defense-in-depth — link.userId == session.hostId by resolver
    // construction, but assert it.
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "Session does not belong to this link's host.",
    });
  }

  // Pipeline-level state guard handles non-agreed states; we only need
  // to detect the terminal-but-not-agreed cases for a clearer wire reason.
  if (session.status === "cancelled" || session.status === "rescheduled") {
    return asCallResult({
      ok: false,
      reason: "session_terminal",
      message: `Session is in terminal state '${session.status}' and cannot be rescheduled.`,
    });
  }

  const result = await rescheduleSession({
    sessionId: session.id,
    hostId: link.userId,
    newSlot: {
      start: new Date(args.newSlot.start),
      durationMinutes: args.newSlot.durationMinutes,
    },
    initiator: "agent",
    initiatorName: args.clientMeta?.principal?.name ?? null,
    reason: args.reason ?? null,
    notifyAttendees: true,
    overrides: args.overrides
      ? {
          ...(args.overrides.format ? { format: args.overrides.format } : {}),
          ...(args.overrides.location !== undefined
            ? { location: args.overrides.location ?? null }
            : {}),
        }
      : undefined,
    idempotencyKey: args.idempotencyKey ?? null,
  });

  if (!result.ok) {
    // Map pipeline outcome → wire refusal reason. The pipeline's outcome
    // strings are 1:1 with wire reasons by design (proposal §3.5).
    const wireReason =
      result.outcome === "session_not_found" ||
      result.outcome === "session_not_agreed" ||
      result.outcome === "slot_mismatch" ||
      result.outcome === "gcal_patch_failed" ||
      result.outcome === "validation_failed"
        ? result.outcome === "validation_failed"
          ? ("session_not_agreed" as const)
          : (result.outcome as
              | "session_not_found"
              | "session_not_agreed"
              | "slot_mismatch"
              | "gcal_patch_failed")
        : ("session_terminal" as const);

    return asCallResult({
      ok: false,
      reason: wireReason,
      message: result.error,
    });
  }

  return asCallResult({
    ok: true,
    sessionId: session.id,
    status: "rescheduled",
    from: result.fromStart,
    to: result.toStart,
    ...(result.changed === false ? { idempotent: true } : {}),
  });
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
// Handler: get_tip
// ---------------------------------------------------------------------------

export async function handleGetTip(
  args: z.infer<typeof getTipInputSchema>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "get_tip",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;
  const parameters = (link.parameters ?? {}) as Record<string, unknown>;

  // Resolve host name for source-label substitution
  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { name: true, preferences: true },
  });
  const hostName = host?.name ?? "Host";

  // Phase 2 PR3c — use getLinkPosture for the tip so the hostNote fallback
  // chain is applied: link.parameters.tip ?? link.hostNote ?? null.
  // Existing hosts who set a hostNote (deprecated field) continue to have it
  // surfaced via get_tip until they explicitly edit the tip (which clears it).
  let linkAuthoredTip: string | null = null;
  try {
    const posture = getLinkPosture(link, { preferences: host?.preferences as import("@/lib/scoring").UserPreferences });
    linkAuthoredTip = posture.tip ?? null;
  } catch {
    // getLinkPosture throws for variance links missing required fields.
    // Fall back to direct read from parameters.
    linkAuthoredTip = typeof parameters.tip === "string" ? parameters.tip : null;
  }

  // 2026-05-12 event-data-model proposal (PR-2b): generated-tip is the new
  // lower-priority slot below authored-link-tip. Reads from
  // parameters.generatedTip; the get_tip MCP tool surfaces it with a new
  // sourceKind enum value `generative-author-time` per the MCP reconciliation.
  const linkGeneratedTip =
    typeof parameters.generatedTip === "string" ? parameters.generatedTip : null;

  // activity/location live in link.parameters (not dedicated columns)
  const linkActivity = typeof parameters.activity === "string" ? parameters.activity : null;
  const linkLocation = typeof parameters.location === "string" ? parameters.location : null;
  const guestPicksLocation =
    (parameters.guestPicks as { location?: boolean } | undefined)?.location === true;
  const guestPicksFormat =
    (parameters.guestPicks as { format?: boolean } | undefined)?.format === true;

  // AP5b: same renderTip call as deal-room renderer — role-invariant templateId/sourceKind
  const rendered = renderTip(
    buildTipInput({
      hostName,
      inviteeName: link.inviteeName ?? "",
      linkFormat: (parameters.format as string | undefined) ?? "video",
      linkActivity,
      linkLocation,
      linkAuthoredTip,
      linkGeneratedTip,
      guestPicksLocation,
      guestPicksFormat,
    }),
    "guest", // external agent = guest perspective for AP5b role-invariance
  );

  return asCallResult({
    ok: true,
    tip: rendered
      ? {
          text: rendered.text,
          source: rendered.source,
          sourceKind: rendered.sourceKind,
          templateId: rendered.templateId,
          generatedAt: rendered.generatedAt,
        }
      : null,
  });
}

// ---------------------------------------------------------------------------
// Handler: get_event_summary
// ---------------------------------------------------------------------------

export async function handleGetEventSummary(
  args: z.infer<typeof getEventSummaryInputSchema>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "get_event_summary",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;

  // Actual NegotiationSession fields (see prisma/schema.prisma model NegotiationSession).
  // Note: eventUrl, phoneNumber, isRecurring, recurringPosition, recurringTotal do NOT
  // exist as columns — we derive them from calendarEventId, negotiatedFormat, and
  // the link's recurrence JSON.
  const sessionSelect = {
    id: true,
    status: true,
    agreedTime: true,
    agreedFormat: true,
    meetLink: true,
    negotiatedLocation: true,
    duration: true,
    guestName: true,
    calendarEventId: true,
    negotiatedFormat: true,
    format: true,
  } as const;

  let session: Prisma.NegotiationSessionGetPayload<{ select: typeof sessionSelect }> | null = null;

  if (args.sessionId) {
    session = await prisma.negotiationSession.findUnique({
      where: { id: args.sessionId },
      select: sessionSelect,
    });
  }

  if (!session) {
    session = await prisma.negotiationSession.findFirst({
      where: { linkId: link.id },
      orderBy: { createdAt: "desc" },
      select: sessionSelect,
    });
  }

  if (!session) {
    return asCallResult({
      ok: false,
      reason: "session_not_found",
      message: "No session found for this meeting URL.",
    });
  }

  // Map session status to summary status
  const statusMap: Record<string, "proposed" | "matched" | "agreed" | "cancelled"> = {
    active: "proposed",
    proposed: "proposed",
    retime_proposed: "proposed",
    escalated: "proposed",
    agreed: "agreed",
    cancelled: "cancelled",
    rescheduled: "agreed",
    expired: "cancelled",
  };
  const summaryStatus = statusMap[session.status ?? "active"] ?? "proposed";

  // Effective format: negotiated > agreedFormat > session.format
  const effectiveFormat =
    session.negotiatedFormat ?? session.agreedFormat ?? session.format ?? null;

  // Channel discrimination (Design X signals, not pre-rendered copy)
  const linkParams = (link.parameters ?? {}) as Record<string, unknown>;
  let channel: unknown = null;
  if (summaryStatus === "agreed" && effectiveFormat) {
    if (effectiveFormat === "video") {
      channel = {
        kind: "video",
        platform: session.meetLink?.includes("zoom.us") ? "Zoom" : "Google Meet",
        joinUrl: session.meetLink ?? null,
      };
    } else if (effectiveFormat === "phone") {
      channel = {
        kind: "phone",
        phoneNumber: "(contact host)", // phone# not stored on session in v1
        hostCallsGuest: true as const,
      };
    } else {
      channel = {
        kind: "in-person",
        location:
          session.negotiatedLocation ??
          (linkParams.location as string | undefined) ??
          "TBD",
      };
    }
  }

  // GCal event URL — calendarEventId is the GCal event id, not a URL.
  // The htmlLink pattern is: https://calendar.google.com/calendar/event?eid=<base64(id)>
  // We surface calendarEventId as a hint; a full htmlLink isn't stored on the session.
  // eventUrl in output schema is nullable — return null when we don't have an htmlLink.
  const eventUrl: string | null = null; // TODO: store htmlLink at confirm time (follow-up)

  // Host name for participants
  const hostUser = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { name: true },
  });
  const hostFirstName = (hostUser?.name ?? "Host").split(" ")[0];
  const guestFirstName = (session.guestName ?? link.inviteeName ?? "Guest").split(" ")[0];

  // Series — derived from link.recurrence (Json field); no per-session position stored yet.
  // Return null for non-recurring links; stub position for recurring (follow-up: per-occurrence rows).
  const recurrence = link.recurrence as Record<string, unknown> | null;
  const series = recurrence
    ? {
        cadence: (recurrence.cadence as string | undefined) ?? "Recurring",
        position: 1, // TODO: derive from LinkOccurrence when position tracking lands
        total: (recurrence.total as number | undefined) ?? 0,
        nextSessionUrl: null,
      }
    : null;

  return asCallResult({
    ok: true,
    summary: {
      status: summaryStatus,
      agreedTime: session.agreedTime?.toISOString() ?? null,
      agreedFormat: (effectiveFormat as "video" | "phone" | "in-person" | null) ?? null,
      eventUrl,
      channel: channel ?? null,
      participants: {
        hostFirstName,
        guestFirstName,
      },
      series,
    },
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
      get_tip: (args) =>
        handleGetTip(args as z.infer<typeof getTipInputSchema>),
      get_event_summary: (args) =>
        handleGetEventSummary(args as z.infer<typeof getEventSummaryInputSchema>),
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
