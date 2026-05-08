/**
 * Host-side MCP tool handlers.
 *
 * `registerHostMcpTools(server, principalCtx)` wires each handler into a
 * per-request `McpServer`. Auth was checked by the route before this is
 * called — handlers get a pre-resolved `HostPrincipalContext`. Scope is
 * checked PER-TOOL inside this module (`wrapWithScopeCheck`), not at the
 * route level. This is the load-bearing fix for the read-only-PAT bug:
 * the previous union-check at route.ts rejected any request unless the
 * token's scope satisfied EVERY registered tool's requiredScope, making
 * `read`-scoped PATs structurally non-functional.
 *
 * Stabilization package §3 Group A (B5 promoted), proposal:
 * `2026-04-30_host-mcp-stabilization-package_reviewed-2026-04-30_decided-2026-04-30.md`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hasScope, type HostPrincipalContext } from "@/app/api/mcp/host/auth";
import {
  HOST_MCP_TOOLS,
  createLinkInput,
  modifyLinkInput,
  getMyAvailabilityInput,
  listMySessionsInput,
  type HostMcpToolName,
} from "@/lib/mcp/host-schemas";
import { handleCreateLink } from "@/agent/actions";
import { writeMcpCallLog } from "@/lib/mcp/call-log";
import { mapSessionStatus } from "@/lib/mcp/tools";
import { hashGuestEmail } from "@/lib/mcp/email-hash";
import { prisma } from "@/lib/prisma";
import { getUserTimezone } from "@/lib/timezone";
import { getOrComputeSchedule } from "@/lib/calendar";
import { getTier, type ScoredSlot, type LinkParameters } from "@/lib/scoring";
import {
  deriveEmittedScore,
  deriveEmittedPreferred,
} from "@/lib/scoring-emit";
import { applyPostureToScope } from "@/lib/links/scope";
import type { PostureUpdate } from "@/lib/links/scope";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }],
  };
}

function fail(reason: string, message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateLinkTool(
  args: z.infer<typeof createLinkInput>,
  userId: string
): Promise<CallToolResult> {
  const params: Record<string, unknown> = {
    topic: args.topic,
    format: args.format,
    duration: args.durationMinutes,
    activity: args.activity,
    activityIcon: args.activityIcon,
    hostNote: args.hostNote,
    timingLabel: args.timingLabel,
    location: args.location,
    inviteeNames: args.inviteeNames ?? [],
  };

  const result = await handleCreateLink(params, userId);

  if (!result.success) {
    const data = result.data as Record<string, unknown> | undefined;
    const errorCode = typeof data?.error === "string" ? data.error : "validation_failed";
    const reason =
      errorCode === "calendar_not_connected"
        ? "calendar_not_connected"
        : errorCode === "no_slug"
          ? "no_slug"
          : "validation_failed";
    return fail(reason, result.message ?? "Link creation failed");
  }

  const d = result.data as {
    sessionId: string;
    linkId: string;
    code: string;
    url: string;
    title: string;
  };

  // PR-C: apply canvas + buffer overrides after creation so they win over
  // the user-default posture snapshot that handleCreateLink seeds.
  const canvasOverride: PostureUpdate = {};
  if (args.availability) canvasOverride.availability = args.availability;
  if (args.bufferMinutes !== undefined) canvasOverride.bufferMinutes = args.bufferMinutes;
  if (Object.keys(canvasOverride).length > 0) {
    await applyPostureToScope(canvasOverride, [d.linkId], userId).catch(() => {
      // Non-fatal: link was created; log and continue.
      console.error("[create_link] canvas override failed for", d.linkId);
    });
  }

  // Derive the slug from the URL — format is always `<origin>/meet/<slug>/<code>`.
  const urlParts = d.url.split("/meet/");
  const slugAndCode = urlParts[1] ?? "";
  const slug = slugAndCode.split("/")[0] ?? "";

  return ok({ linkCode: d.code, slug, url: d.url });
}

// ---------------------------------------------------------------------------
// modify_link  (PR-C, proposal §8 Rule 13 parity)
// ---------------------------------------------------------------------------

async function handleModifyLinkTool(
  args: z.infer<typeof modifyLinkInput>,
  userId: string
): Promise<CallToolResult> {
  const link = await prisma.negotiationLink.findUnique({
    where: { id: args.linkId },
    select: { id: true, userId: true, topic: true },
  });
  if (!link) return fail("link_not_found", `Link ${args.linkId} not found`);
  if (link.userId !== userId) return fail("not_authorized", "Link does not belong to this host");

  const update: PostureUpdate = {};
  const fieldsUpdated: string[] = [];

  if (args.availability !== undefined) { update.availability = args.availability; fieldsUpdated.push("availability"); }
  if (args.duration !== undefined) { update.duration = args.duration; fieldsUpdated.push("duration"); }
  if (args.bufferMinutes !== undefined) { update.bufferMinutes = args.bufferMinutes; fieldsUpdated.push("bufferMinutes"); }
  if (args.format !== undefined) { update.format = args.format; fieldsUpdated.push("format"); }
  if (args.eveningsPosture !== undefined) { update.eveningsPosture = args.eveningsPosture; fieldsUpdated.push("eveningsPosture"); }

  if (Object.keys(update).length > 0) {
    await applyPostureToScope(update, [args.linkId], userId);
  }

  if (args.topic !== undefined) {
    await prisma.negotiationLink.update({ where: { id: args.linkId }, data: { topic: args.topic } });
    fieldsUpdated.push("topic");
  }

  return ok({ linkId: args.linkId, fieldsUpdated });
}

// ---------------------------------------------------------------------------
// get_my_availability  (PR-2, parent §5.4)
// ---------------------------------------------------------------------------

async function handleGetMyAvailabilityTool(
  args: z.infer<typeof getMyAvailabilityInput>,
  userId: string
): Promise<CallToolResult> {
  const host = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const prefs = (host?.preferences ?? {}) as Record<string, unknown>;
  const hostTimezone = getUserTimezone(prefs);
  const displayTz = args.timezone ?? hostTimezone;

  const schedule = await getOrComputeSchedule(userId);
  if (!schedule.connected) {
    return fail(
      "calendar_not_connected",
      "Connect your Google Calendar in Preferences before reading availability."
    );
  }

  // No link rules apply at the host surface — the principal IS the host,
  // so there's no link.parameters / guestPicks.window / VIP gating. Just
  // the global scored schedule + caller-supplied dateRange clip.
  let slots: ScoredSlot[] = schedule.slots;

  // Score filter: same as guest non-VIP path. The host is reading their
  // own calendar; protected-band stretches don't make sense here.
  slots = slots.filter((s) => s.score <= 1);

  // Drop past slots.
  const now = Date.now();
  slots = slots.filter((s) => new Date(s.start).getTime() > now);

  // dateRange clip in display timezone (YYYY-MM-DD).
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: displayTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const { start: rangeStart, end: rangeEnd } = args.dateRange;
  slots = slots.filter((s) => {
    const local = dateFmt.format(new Date(s.start));
    return local >= rangeStart && local <= rangeEnd;
  });

  // Sort best-first (score asc; ties broken by earliest), then cap.
  slots.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });
  const limit = args.limit ?? 20;
  if (slots.length > limit) {
    slots = slots.slice(0, limit);
  }

  // Format localStart in host timezone (matches guest schema; saves agents UTC math).
  const localFmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: hostTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // No link rules to drive tier/VIP semantics → emit the bookable-band tier
  // for everything. Empty rules passed to the shared derivation helpers;
  // with no per-link expansion / restriction / preferred fields, both
  // helpers fall through to identity (`emittedScore === s.score`,
  // `preferred: false`) — same observable output as the prior inline
  // derivation. The fold is structural: future User-level
  // `availability.*` / `preferred.*` defaults will route through the
  // same helper. MCP-B1 fold of the 2026-05-01 event-availability proposal.
  const emptyRules = {} as LinkParameters;
  const wireSlots = slots.map((s) => {
    const tier = getTier(s, emptyRules, hostTimezone);
    const wireTier =
      tier === "first-offer" ? "first_offer"
      : tier === "stretch1" ? "stretch1"
      : tier === "stretch2" ? "stretch2"
      : undefined;
    const emittedScore = deriveEmittedScore(s, emptyRules, hostTimezone);
    const preferred = deriveEmittedPreferred(s, emptyRules, hostTimezone);
    const localStart = localFmt.format(new Date(s.start)).replace(" ", "T");
    return {
      start: s.start,
      end: s.end,
      localStart,
      score: emittedScore,
      ...(wireTier ? { tier: wireTier } : {}),
      ...(preferred ? { preferred: true } : {}),
    };
  });

  const dateFmtHost = new Intl.DateTimeFormat("en-CA", {
    timeZone: hostTimezone,
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

  return ok({ timezone: displayTz, slots: wireSlots, slotsThrough });
}

// ---------------------------------------------------------------------------
// list_my_sessions  (PR-2, parent §5.5)
// ---------------------------------------------------------------------------

async function handleListMySessionsTool(
  args: z.infer<typeof listMySessionsInput>,
  userId: string
): Promise<CallToolResult> {
  // Map wire status enum → DB status. "all" = no filter.
  // Wire's "active" maps to DB "active" + "escalated" (the latter is an
  // internal detour, externally still active per mapSessionStatus).
  const statusFilter =
    args.status === "all"
      ? undefined
      : args.status === "active"
        ? { in: ["active", "escalated"] }
        : args.status;

  const limit = args.limit ?? 50;

  const sessions = await prisma.negotiationSession.findMany({
    where: {
      hostId: userId,
      ...(statusFilter !== undefined ? { status: statusFilter } : {}),
      ...(args.linkCode ? { link: { code: args.linkCode } } : {}),
    },
    select: {
      id: true,
      status: true,
      guestName: true,
      guestEmail: true,
      agreedTime: true,
      updatedAt: true,
      link: { select: { code: true, hashSalt: true } },
      _count: { select: { messages: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  const wireSessions = sessions.map((s) => ({
    sessionId: s.id,
    linkCode: s.link.code ?? "",
    status: mapSessionStatus(s.status),
    guestName: s.guestName,
    // Per-link salted hash. Never plaintext. SPEC §4 invariant.
    guestEmailHash: s.guestEmail ? hashGuestEmail(s.link.hashSalt, s.guestEmail) : null,
    agreedTime: s.agreedTime?.toISOString() ?? null,
    lastActivityAt: s.updatedAt.toISOString(),
    messageCount: s._count.messages,
  }));

  return ok({ sessions: wireSessions });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Wrap a handler with a per-tool scope check. The principal's scope set is
 * checked against the tool's `requiredScope` at call time — so a `read`-only
 * PAT can call read tools, a `schedule` PAT can call read + schedule tools,
 * and an `admin` PAT can call everything (per the cascade in `auth.ts`).
 *
 * Returning a typed `scope_denied` is intentionally per-call rather than
 * per-request — the agent can keep its connection and try a different tool
 * without re-handshaking.
 */
function wrapWithScopeCheck(
  toolName: HostMcpToolName,
  principalCtx: HostPrincipalContext & { ok: true },
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  const required = HOST_MCP_TOOLS[toolName].requiredScope;
  return async (args) => {
    if (!hasScope(principalCtx.scopes, required)) {
      return fail(
        "scope_denied",
        `This tool requires scope "${required}". Your token has: ${principalCtx.scopes.join(", ")}.`
      );
    }
    return handler(args);
  };
}

/**
 * Wrap a handler with MCPCallLog writing. Mirrors guest-side `withCallLogging`
 * (`tools.ts:1175`) but populates host fields per parent §7.4: `userId` set,
 * `linkId` null, `principal: { kind: "host_pat", tokenId, displayId }`.
 *
 * Same fire-and-forget semantics — log writes never block the response.
 */
function withHostCallLogging(
  toolName: HostMcpToolName,
  principalCtx: HostPrincipalContext & { ok: true },
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    const started = Date.now();
    const result = await handler(args);
    const latencyMs = Date.now() - started;

    // Result content[0] is JSON-serialized text per ok()/fail() helpers.
    let response: Record<string, unknown> = {};
    try {
      const first = result.content?.[0];
      if (first && first.type === "text" && typeof first.text === "string") {
        response = JSON.parse(first.text) as Record<string, unknown>;
      }
    } catch {
      response = { ok: false, reason: "log_parse_failed" };
    }

    void writeMcpCallLog({
      tool: toolName,
      userId: principalCtx.userId,
      principal: {
        kind: "host_pat",
        tokenId: principalCtx.tokenId,
        displayId: principalCtx.displayId,
      },
      requestArgs: args,
      response,
      latencyMs,
    });

    return result;
  };
}

export function registerHostMcpTools(
  server: McpServer,
  principalCtx: HostPrincipalContext & { ok: true }
): void {
  const handlers: Record<
    HostMcpToolName,
    (args: Record<string, unknown>) => Promise<CallToolResult>
  > = {
    create_link: (args) =>
      handleCreateLinkTool(
        args as z.infer<typeof createLinkInput>,
        principalCtx.userId
      ),
    modify_link: (args) =>
      handleModifyLinkTool(
        args as z.infer<typeof modifyLinkInput>,
        principalCtx.userId
      ),
    get_my_availability: (args) =>
      handleGetMyAvailabilityTool(
        args as z.infer<typeof getMyAvailabilityInput>,
        principalCtx.userId
      ),
    list_my_sessions: (args) =>
      handleListMySessionsTool(
        args as z.infer<typeof listMySessionsInput>,
        principalCtx.userId
      ),
  };

  for (const name of Object.keys(HOST_MCP_TOOLS) as HostMcpToolName[]) {
    const tool = HOST_MCP_TOOLS[name];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputShape = (tool.input as any).shape as Record<string, any>;
    // Composition: scope check OUTSIDE call logging — denied calls still get
    // logged (signal: which tokens are trying which tools they shouldn't).
    const wrapped = withHostCallLogging(
      name,
      principalCtx,
      wrapWithScopeCheck(name, principalCtx, handlers[name])
    );
    server.registerTool(
      name,
      { description: tool.description, inputSchema: inputShape },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapped as any
    );
  }
}
