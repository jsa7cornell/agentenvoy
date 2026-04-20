import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateCode } from "@/lib/utils";
import { getUserTimezone, shortTimezoneLabel } from "@/lib/timezone";
import type { AvailabilityRule } from "@/lib/availability-rules";
import { normalizeLinkRules } from "@/lib/scoring";
import { createTentativeHoldEvent, deleteCalendarEvent } from "@/lib/calendar";
import { parseTimeOfDay, TIME_OF_DAY_WINDOWS } from "@/lib/time-of-day";
import { sanitizeHostFlavor, sanitizeSuggestionList } from "@/lib/host-flavor-sanitizer";
import { logCalibrationWrite } from "@/lib/calibration-audit";

// --- Helpers ---

/** Topics that are just filler — LLMs emit these when no real topic was given. */
const GENERIC_TOPICS = new Set([
  "meeting", "catch up", "catch-up", "catchup", "chat", "sync",
  "check in", "check-in", "checkin", "connect", "touch base",
  "quick chat", "quick meeting", "quick sync", "discussion",
]);

function isGenericTopic(topic: string): boolean {
  return GENERIC_TOPICS.has(topic.trim().toLowerCase());
}

// --- Types ---

export interface ActionRequest {
  action: string;
  params: Record<string, unknown>;
}

export interface ActionResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

// --- Parser ---

const ACTION_REGEX = /\[ACTION\](.*?)\[\/ACTION\]/g;

/**
 * Parse [ACTION]...[/ACTION] blocks from AI response text.
 * Returns an array of parsed action requests.
 */
export function parseActions(text: string): ActionRequest[] {
  const actions: ActionRequest[] = [];
  let match;
  const regex = new RegExp(ACTION_REGEX.source, ACTION_REGEX.flags);
  while ((match = regex.exec(text)) !== null) {
    try {
      let raw = match[1].trim();
      // Fix common LLM JSON errors: trailing extra braces
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Try removing trailing extra closing braces
        while (raw.endsWith("}}") || raw.endsWith("}]")) {
          const trimmed = raw.slice(0, -1);
          try {
            parsed = JSON.parse(trimmed);
            break;
          } catch {
            raw = trimmed;
          }
        }
      }
      if (parsed?.action && typeof parsed.action === "string") {
        actions.push({
          action: parsed.action,
          params: parsed.params || {},
        });
      }
    } catch {
      console.error("Failed to parse action block:", match[1]);
    }
  }
  return actions;
}

/**
 * Strip all [ACTION]...[/ACTION] blocks from text for display.
 */
export function stripActionBlocks(text: string): string {
  return text.replace(/\s*\[ACTION\].*?\[\/ACTION\]\s*/g, "").trim();
}

// --- Executor ---

/**
 * Execute all parsed actions sequentially. Each action is authorized and validated.
 */
export async function executeActions(
  actions: ActionRequest[],
  userId: string,
  context?: { sessionId?: string; meetSlug?: string }
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of actions) {
    try {
      const result = await executeAction(action, userId, context);
      results.push(result);
    } catch (e) {
      console.error(`Action "${action.action}" failed:`, e);
      results.push({
        success: false,
        message: `Action "${action.action}" failed unexpectedly`,
      });
    }
  }
  return results;
}

async function executeAction(
  action: ActionRequest,
  userId: string,
  context?: { sessionId?: string; meetSlug?: string }
): Promise<ActionResult> {
  switch (action.action) {
    case "archive":
      return handleArchive(action.params, userId);
    case "archive_bulk":
      return handleArchiveBulk(action.params, userId);
    case "unarchive":
      return handleUnarchive(action.params, userId);
    case "cancel":
      return handleCancel(action.params, userId);
    case "update_format":
      return handleUpdateFormat(action.params, userId, context?.sessionId);
    case "update_time":
      return handleUpdateTime(action.params, userId, context?.sessionId);
    case "update_location":
      return handleUpdateLocation(action.params, userId, context?.sessionId);
    case "create_link":
      return handleCreateLink(action.params, userId, context?.meetSlug);
    case "expand_link":
    case "update_link":
      // `update_link` is the canonical name; `expand_link` is kept as an
      // alias because earlier playbook revisions used it. Same handler,
      // same semantics. The LLM reliably reaches for "update_link" when
      // editing link rules — don't force it through the older name.
      return handleExpandLink(action.params, userId);
    case "hold_slot":
      return handleHoldSlot(action.params, userId);
    case "release_hold":
      return handleReleaseHold(action.params, userId);
    case "update_knowledge":
      return handleUpdateKnowledge(action.params, userId);
    case "update_meeting_settings":
      return handleUpdateMeetingSettings(action.params, userId);
    case "save_guest_info":
      return handleSaveGuestInfo(action.params, userId, context?.sessionId);
    default:
      return { success: false, message: `Unknown action: ${action.action}` };
  }
}

// --- Authorization helper ---

async function getAuthorizedSession(sessionId: unknown, userId: string): Promise<ActionResult | { session: { id: string; hostId: string; status: string; title: string | null; linkId: string; calendarEventId: string | null; archived: boolean; guestEmail: string | null; guestName: string | null; link: { id: string; type: string; inviteeName: string | null; topic: string | null; rules: unknown } } }> {
  if (!sessionId || typeof sessionId !== "string") {
    return { success: false, message: "Missing or invalid sessionId" };
  }
  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      hostId: true,
      status: true,
      title: true,
      linkId: true,
      calendarEventId: true,
      archived: true,
      guestEmail: true,
      guestName: true,
      link: {
        select: {
          id: true,
          type: true,
          inviteeName: true,
          topic: true,
          rules: true,
        },
      },
    },
  });
  if (!session) return { success: false, message: `Session not found: ${sessionId}` };
  if (session.hostId !== userId) return { success: false, message: "Not authorized for this session" };
  return { session };
}

/**
 * Placeholder strings the LLM invents when it doesn't have a real session ID
 * in context (e.g. right after a create_link in the same turn, the cuid wasn't
 * returned to the model yet). Observed 2026-04-20: Envoy emitted
 * `"sessionId":"LAST_CREATED"` for update_format/update_time, the action
 * failed with "Session not found: LAST_CREATED", but the narration claimed
 * success — DB was unchanged.
 *
 * Rather than forbidding this in the playbook (fragile) we resolve it
 * server-side: any placeholder (or missing sessionId) on an update_* action
 * falls back to the most recently created non-archived session for this host.
 * That's almost always what the model meant when it just ran create_link or
 * is following up on the last thing it did.
 */
/**
 * "Pre-engagement" = the host is tweaking a link that no guest has interacted
 * with yet. Writing `status=proposed, statusLabel="Time change proposed by
 * host"` or overwriting `statusLabel` on a never-sent draft is misleading —
 * there's nobody to propose to. Detect this and let handlers soften their
 * behavior (no status flip, no statusLabel clobber) while still mirroring the
 * change to `link.rules` so a future guest sees the right offer.
 *
 * Signal: no guest-role messages exist AND the session has no guestEmail/
 * guestName captured AND status is still in a mutable pre-agreed state.
 */
async function isPreEngagement(
  session: { id: string; status: string; guestEmail: string | null; guestName: string | null }
): Promise<boolean> {
  if (session.status === "agreed" || session.status === "escalated") return false;
  if (session.guestEmail || session.guestName) return false;
  const guestMsgCount = await prisma.message.count({
    where: { sessionId: session.id, role: "guest" },
  });
  return guestMsgCount === 0;
}

const SESSION_ID_PLACEHOLDERS = new Set([
  "LAST_CREATED", "LAST", "LATEST", "LAST_SESSION", "LATEST_SESSION",
  "NEW", "NEW_SESSION", "JUST_CREATED", "CURRENT", "CURRENT_SESSION",
  "$LAST", "LAST_ID", "SESSION_ID",
]);

function looksLikePlaceholderSessionId(s: string): boolean {
  if (!s) return true;
  if (SESSION_ID_PLACEHOLDERS.has(s.toUpperCase())) return true;
  // Real Prisma cuids are lowercase alphanumeric. Any uppercase letter or
  // `$` prefix is a giveaway for an LLM-invented placeholder.
  if (/[A-Z]/.test(s) || s.startsWith("$")) return true;
  return false;
}

async function resolveSessionId(
  params: Record<string, unknown>,
  userId: string,
  contextSessionId?: string,
): Promise<string | undefined> {
  const raw = ((params.sessionId as string | undefined) ?? contextSessionId ?? "").trim();
  if (raw && !looksLikePlaceholderSessionId(raw)) {
    return raw;
  }
  if (raw) {
    console.warn(
      `[resolveSessionId] placeholder sessionId "${raw}" — falling back to latest session for user ${userId}`,
    );
  }
  const latest = await prisma.negotiationSession.findFirst({
    where: { hostId: userId, archived: false },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return latest?.id;
}

/**
 * Patch link.rules with a partial change — ONLY for contextual links
 * (one link = one session, so the update is intent-aligned). For generic
 * links (one link, many sessions) we skip the write so a dashboard tweak
 * for one guest doesn't retroactively change every future guest's
 * experience on the same shared link.
 *
 * Historical bug (pre-2026-04-18): update_format / update_location /
 * update_time handlers only mutated NegotiationSession.* fields, but the
 * greeting template + confirm route read from `link.rules.*` FIRST. The
 * result: dashboard chat said "Updated format to in-person" and the deal
 * room kept showing the original video format. This helper exists to
 * keep the two fields in lockstep going forward.
 */
async function patchLinkRulesForContextual(
  link: { id: string; type: string; rules: unknown },
  changes: Record<string, unknown>,
): Promise<void> {
  if (link.type !== "contextual") return;
  const existing = (link.rules as Record<string, unknown>) || {};
  const next: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  await prisma.negotiationLink.update({
    where: { id: link.id },
    data: { rules: next as Parameters<typeof prisma.negotiationLink.update>[0]["data"]["rules"] },
  });
}

// --- Action Handlers ---

async function handleArchive(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const auth = await getAuthorizedSession(await resolveSessionId(params, userId), userId);
  if (!("session" in auth)) return auth;
  const { session } = auth;

  await prisma.negotiationSession.update({
    where: { id: session.id },
    data: { archived: true },
  });

  const name = session.link.inviteeName || session.title || "session";
  return { success: true, message: `Archived "${name}"`, data: { sessionId: session.id } };
}

async function handleArchiveBulk(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const filter = params.filter as string;
  if (!filter || !["unconfirmed", "all", "expired", "cancelled"].includes(filter)) {
    return { success: false, message: `Invalid filter: ${filter}. Use "unconfirmed", "expired", "cancelled", or "all".` };
  }

  const where: Record<string, unknown> = {
    hostId: userId,
    archived: false,
  };

  if (filter === "unconfirmed") {
    where.status = { in: ["active", "proposed", "escalated"] };
  } else if (filter === "expired") {
    where.status = "expired";
  } else if (filter === "cancelled") {
    where.status = "cancelled";
  }
  // "all" — no status filter, archives everything non-archived

  const result = await prisma.negotiationSession.updateMany({
    where: where as Parameters<typeof prisma.negotiationSession.updateMany>[0]["where"],
    data: { archived: true },
  });

  return {
    success: true,
    message: `Archived ${result.count} session${result.count !== 1 ? "s" : ""} (filter: ${filter})`,
    data: { count: result.count },
  };
}

async function handleUnarchive(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const auth = await getAuthorizedSession(await resolveSessionId(params, userId), userId);
  if (!("session" in auth)) return auth;
  const { session } = auth;

  await prisma.negotiationSession.update({
    where: { id: session.id },
    data: { archived: false },
  });

  const name = session.link.inviteeName || session.title || "session";
  return { success: true, message: `Unarchived "${name}"`, data: { sessionId: session.id } };
}

async function handleCancel(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const sessionId = await resolveSessionId(params, userId);
  const auth = await getAuthorizedSession(sessionId, userId);
  if (!("session" in auth)) return auth;
  const { session } = auth;

  if (session.status === "cancelled") {
    return { success: false, message: "Session is already cancelled" };
  }

  const reason = (params.reason as string) || "Cancelled by host";
  await prisma.negotiationSession.update({
    where: { id: session.id },
    data: {
      status: "cancelled",
      statusLabel: reason,
    },
  });

  // Save a system message in the deal room
  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "system",
      content: `Meeting cancelled: ${reason}`,
    },
  });

  const name = session.link.inviteeName || session.title || "session";
  return { success: true, message: `Cancelled "${name}"`, data: { sessionId: session.id } };
}

/**
 * For confirmed (agreed + calendarEventId) sessions, post a gcal_update_proposal
 * channel message instead of writing directly. The host sees a GcalUpdateCard
 * in the feed and must click Confirm before we touch GCal.
 */
async function postGcalUpdateProposal(
  session: { id: string; hostId: string; calendarEventId: string | null },
  userId: string,
  proposed: Record<string, unknown>,
): Promise<ActionResult> {
  // Upsert the host's channel (mirrors confirm/route.ts pattern)
  let channel = await prisma.channel.findUnique({ where: { userId } });
  if (!channel) channel = await prisma.channel.create({ data: { userId } });

  await prisma.channelMessage.create({
    data: {
      channelId: channel.id,
      role: "system",
      content: "Envoy is proposing an update to the confirmed meeting.",
      threadId: session.id,
      metadata: {
        kind: "gcal_update_proposal",
        sessionId: session.id,
        eventId: session.calendarEventId,
        proposed: proposed as Record<string, string | number | boolean | null>,
      },
    },
  });

  return {
    success: true,
    message: "Proposal posted — host must confirm in the feed before GCal is updated.",
    data: { sessionId: session.id, pendingGcalUpdate: true },
  };
}

async function handleUpdateFormat(
  params: Record<string, unknown>,
  userId: string,
  contextSessionId?: string
): Promise<ActionResult> {
  const sessionId = await resolveSessionId(params, userId, contextSessionId);
  const auth = await getAuthorizedSession(sessionId, userId);
  if (!("session" in auth)) return auth;
  const { session } = auth;

  const format = params.format as string;
  if (!format || !["phone", "video", "in-person"].includes(format)) {
    return { success: false, message: `Invalid format: ${format}. Use "phone", "video", or "in-person".` };
  }

  // For confirmed meetings already on GCal, propose the update via UI card
  // instead of writing directly — the user must confirm before we patch GCal.
  if (session.calendarEventId && session.status === "agreed" && !session.archived) {
    return await postGcalUpdateProposal(session, userId, { format });
  }

  // Dual-write: session.format for parity with the existing session row,
  // AND link.rules.format (for contextual links) so the greeting template
  // and confirm route actually see the change. See patchLinkRulesForContextual
  // for the historical bug this fixes.
  await prisma.negotiationSession.update({
    where: { id: session.id },
    data: { format },
  });
  await patchLinkRulesForContextual(session.link, { format });

  // Post a system message so the thread reflects what the dashboard did —
  // previously only update_time / update_location did this, so update_format
  // changes were invisible to anyone reading the deal-room history.
  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "system",
      content: `Format updated to ${format}`,
      metadata: { kind: "host_update", field: "format" },
    },
  });

  return {
    success: true,
    message: `Updated format to ${format}`,
    data: { sessionId: session.id, format },
  };
}

async function handleUpdateTime(
  params: Record<string, unknown>,
  userId: string,
  contextSessionId?: string
): Promise<ActionResult> {
  const sessionId = await resolveSessionId(params, userId, contextSessionId);
  const auth = await getAuthorizedSession(sessionId, userId);
  if (!("session" in auth)) return auth;
  const { session } = auth;

  const dateTime = params.dateTime as string | undefined;
  const durationRaw = params.duration !== undefined && params.duration !== null
    ? Number(params.duration)
    : undefined;
  const duration = durationRaw !== undefined && !isNaN(durationRaw) ? durationRaw : undefined;

  // Accept dateTime OR duration — duration-only edits ("change it to 50 min")
  // must not require a new start time. At least one must be present.
  if (!dateTime && duration === undefined) {
    return { success: false, message: "Missing dateTime or duration parameter" };
  }

  const parsed = dateTime ? new Date(dateTime) : null;
  if (parsed && isNaN(parsed.getTime())) {
    return { success: false, message: `Invalid dateTime: ${dateTime}` };
  }

  // For confirmed meetings already on GCal, propose via UI card.
  if (session.calendarEventId && session.status === "agreed" && !session.archived) {
    const endTime = parsed && duration !== undefined
      ? new Date(parsed.getTime() + duration * 60 * 1000)
      : undefined;
    return await postGcalUpdateProposal(session, userId, {
      ...(parsed ? { startTime: parsed.toISOString() } : {}),
      ...(endTime ? { endTime: endTime.toISOString() } : {}),
      ...(duration !== undefined ? { duration } : {}),
    });
  }

  // Duration-only edit on a non-confirmed session: no re-propose, just mirror
  // the duration through link.rules + post a system message. Leave status alone.
  if (!parsed && duration !== undefined) {
    await prisma.negotiationSession.update({
      where: { id: session.id },
      data: { duration },
    });
    await patchLinkRulesForContextual(session.link, { duration });
    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: "system",
        content: `Duration updated to ${duration} min`,
        metadata: { kind: "host_update", field: "duration" },
      },
    });
    return {
      success: true,
      message: `Updated duration to ${duration} min`,
      data: { sessionId: session.id, duration },
    };
  }

  // Pre-engagement guard: if no guest has engaged yet, do NOT flip the session
  // into `proposed` with a "Time change proposed by host" label — there's no
  // one to propose to. Mirror the intent into link.rules (dateRange + duration)
  // so the first guest to land sees the right offer, and tell the LLM to stop
  // synthesizing specific times from window-shaped requests.
  if (await isPreEngagement(session)) {
    return {
      success: false,
      message:
        "This link has no engaged guest yet — use update_link (dateRange / preferredDays / duration) to adjust the offer on the link itself. update_time should only be used after a guest has engaged, to re-propose a specific slot.",
    };
  }

  const updateData: Record<string, unknown> = {
    status: "proposed",
    statusLabel: "Time change proposed by host",
  };

  if (duration !== undefined) updateData.duration = duration;
  // NOTE: params.timezone from the LLM is deliberately IGNORED.
  // The host's canonical timezone is looked up from stored preferences.
  const host = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const hostTz = getUserTimezone(host?.preferences as Record<string, unknown> | null);

  await prisma.negotiationSession.update({
    where: { id: session.id },
    data: updateData as Parameters<typeof prisma.negotiationSession.update>[0]["data"],
  });
  // Mirror duration into link.rules.duration for contextual links so the
  // greeting template + confirm card reflect it. Same reason as format /
  // location — link.rules wins the precedence chain.
  if (duration !== undefined) {
    await patchLinkRulesForContextual(session.link, { duration });
  }

  // Save a system message so the guest sees the proposal
  const durationStr = duration !== undefined ? ` (${duration} min)` : "";
  // parsed is guaranteed here: the duration-only branch above returned early.
  const nonNullParsed = parsed as Date;
  const tzLabel = ` ${shortTimezoneLabel(hostTz, nonNullParsed)}`;
  const timeStr = nonNullParsed.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: hostTz,
  });
  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "system",
      content: `Proposed new time: ${timeStr}${tzLabel}${durationStr}`,
      metadata: { kind: "host_update", field: "time" },
    },
  });

  return {
    success: true,
    message: `Proposed new time: ${timeStr}${tzLabel}`,
    data: { sessionId: session.id },
  };
}

async function handleUpdateLocation(
  params: Record<string, unknown>,
  userId: string,
  contextSessionId?: string
): Promise<ActionResult> {
  const sessionId = await resolveSessionId(params, userId, contextSessionId);
  const auth = await getAuthorizedSession(sessionId, userId);
  if (!("session" in auth)) return auth;
  const { session } = auth;

  const location = params.location as string;
  if (!location) {
    return { success: false, message: "Missing location parameter" };
  }

  // For confirmed meetings already on GCal, propose via UI card.
  if (session.calendarEventId && session.status === "agreed" && !session.archived) {
    return await postGcalUpdateProposal(session, userId, { location });
  }

  // Dual-write: statusLabel for the host-facing dashboard and a system
  // message for the thread history, AND link.rules.location for contextual
  // links so the confirm card + GCal event actually use the new location.
  // Previously this only wrote statusLabel + a system message, leaving
  // link.rules.location untouched — the confirm route reads link.rules.location
  // and so silently ignored the update.
  //
  // Pre-engagement: skip the statusLabel clobber — "Location updated to X" on
  // a never-engaged draft is misleading and overrides the draft-state label.
  // Still mirror to link.rules + post the system note so the offer is correct.
  const preEngagement = await isPreEngagement(session);
  if (!preEngagement) {
    await prisma.negotiationSession.update({
      where: { id: session.id },
      data: {
        statusLabel: `Location updated to ${location}`,
      },
    });
  }
  await patchLinkRulesForContextual(session.link, { location });

  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "system",
      content: `Location updated: ${location}`,
      metadata: { kind: "host_update", field: "location" },
    },
  });

  return {
    success: true,
    message: `Updated location to "${location}"`,
    data: { sessionId: session.id, location },
  };
}

async function handleCreateLink(
  params: Record<string, unknown>,
  userId: string,
  meetSlug?: string
): Promise<ActionResult> {
  // Always fetch both slug (if needed) and name in one query so the session
  // title can use "John + Guest" format. When meetSlug is already provided via
  // context we still need the name — combine into a single lookup.
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { meetSlug: true, name: true },
  });
  if (!meetSlug) {
    meetSlug = userRow?.meetSlug || undefined;
  }
  const hostName: string | null = userRow?.name || null;

  if (!meetSlug) {
    return { success: false, message: "No meet slug configured. Set up your profile first." };
  }

  const code = generateCode();
  const inviteeName = (params.inviteeName as string) || null;
  const inviteeEmail = (params.inviteeEmail as string) || null;
  // Host-declared guest TZ (e.g. "Sarah is on EST"). Validated via Intl —
  // invalid zones silently drop to null rather than throw, so a bad LLM
  // extraction doesn't block link creation.
  let inviteeTimezone: string | null = null;
  const rawInviteeTz = params.inviteeTimezone as string | undefined;
  if (rawInviteeTz && typeof rawInviteeTz === "string" && rawInviteeTz.length <= 64) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: rawInviteeTz });
      inviteeTimezone = rawInviteeTz;
    } catch {
      console.warn(`[create_link] invalid inviteeTimezone "${rawInviteeTz}" — dropping`);
    }
  }
  // Strip generic filler topics — LLMs often set "Meeting" or "Catch up" when
  // the host didn't specify a topic, which produces "about Meeting" in the greeting.
  const rawTopic = (params.topic as string) || null;
  const topic = rawTopic && isGenericTopic(rawTopic) ? null : rawTopic;

  // hostNote — host-supplied framing surfaced verbatim in greeting. Defense-in-
  // depth: reject newlines/control chars at the boundary, then route through
  // sanitizeHostFlavor (same precedent as guestGuidance.tone). The sanitizer
  // strips URLs/emails/phones and rejects injection markers; on rejection we
  // log + persist null. On accept we slice to the column cap (280).
  let hostNote: string | null = null;
  const rawHostNote = params.hostNote;
  if (typeof rawHostNote === "string") {
    const trimmed = rawHostNote.trim();
    if (trimmed && !/[\n\r\t\u0000-\u001f]/.test(trimmed)) {
      const result = sanitizeHostFlavor(trimmed);
      if (result.rejected) {
        console.warn(
          `[create_link] hostNote rejected (${result.reason}) — raw: ${JSON.stringify(result.raw).slice(0, 200)}`
        );
      } else if (result.safe) {
        hostNote = result.safe.slice(0, 280);
      }
    } else if (trimmed) {
      console.warn(`[create_link] hostNote dropped — contains newline or control char`);
    }
  }
  const format = (params.format as string) || null;
  const urgency = (params.urgency as string) || null;
  // Meeting location for in-person (or phone/video where host wants to pin
  // a specific address/URL). Flows into link.rules.location so the deal-
  // room greeting can reference it and the confirm step uses it as the
  // GCal event location.
  const rawLocation = params.location;
  const location = typeof rawLocation === "string" && rawLocation.trim() ? rawLocation.trim() : null;
  // Activity — free-form short phrase describing what the meeting is (e.g.
  // "bike ride", "coffee", "welcome-back lunch"). Paired with a single emoji
  // icon the LLM picks. Both free-form on purpose — the taxonomy of possible
  // meeting activities is too broad for a discrete enum. Empty/null when the
  // host gave no activity framing (neutral calls/meetings).
  const rawActivity = params.activity;
  const activity = typeof rawActivity === "string" && rawActivity.trim()
    ? rawActivity.trim().slice(0, 60)
    : null;
  const rawActivityIcon = params.activityIcon;
  // Single-codepoint emoji guardrail — prevents abuse or long strings masquerading
  // as icons. We don't validate that it IS an emoji, just that it's short.
  const activityIcon = typeof rawActivityIcon === "string" && rawActivityIcon.trim().length > 0 && rawActivityIcon.length <= 8
    ? rawActivityIcon.trim()
    : null;
  // Timing label — free-form human phrase ("next week", "mid-May",
  // "this weekend"). Purely display; the scoring engine uses dateRange
  // and preferredDays for actual filtering.
  const rawTimingLabel = params.timingLabel;
  const timingLabel = typeof rawTimingLabel === "string" && rawTimingLabel.trim()
    ? rawTimingLabel.trim().slice(0, 80)
    : null;
  const rules = (params.rules as Record<string, unknown>) || {};

  // Drift detector (2026-04-20): the channel playbook asks the LLM to populate
  // hostNote whenever the host's phrasing carries context — including
  // structured constraints expressed conversationally ("on Tuesday or
  // Wednesday next week"). If we see structured constraints set but no
  // hostNote, that's a signal the LLM forgot to carry context through.
  // Warn-only — don't block link creation. Monitor Vercel logs; if this
  // fires on real "with narrative context" cases, revisit the playbook.
  const hasStructuredConstraints =
    Array.isArray(rules.preferredDays) ||
    !!rules.dateRange ||
    !!rules.preferredTimeStart ||
    !!rules.preferredTimeEnd ||
    !!params.preferredTimeStart ||
    !!params.preferredTimeEnd;
  if (hasStructuredConstraints && !hostNote) {
    console.warn(
      `[create_link] hostNote missing for structured constraint — invitee=${inviteeName} rules=${JSON.stringify({
        preferredDays: rules.preferredDays,
        dateRange: rules.dateRange,
        preferredTimeStart: rules.preferredTimeStart ?? params.preferredTimeStart,
      })}`,
    );
  }

  // Merge format/duration/urgency/VIP/window into rules so they're available
  // at greeting/composer time. isVip is a binary flag — it tells Envoy she
  // may proactively ask the host about opening up stretch hours and may
  // reach into stretch options on guest pushback (see getTier in scoring.ts).
  // isVip alone does NOT auto-unlock protected hours; the host must still
  // confirm specific hours via preferredTimeStart/End or allowWeekends.
  // Normalize day-name arrays and dateRange shape — LLMs occasionally emit
  // long day names ("Monday") or short ones ("Mon"); persist the canonical form.
  const isVip = params.isVip === true;
  const allowWeekends = params.allowWeekends === true;
  const preferredTimeStart = typeof params.preferredTimeStart === "string" ? params.preferredTimeStart : undefined;
  const preferredTimeEnd = typeof params.preferredTimeEnd === "string" ? params.preferredTimeEnd : undefined;

  // Temporal constraints — previously these only came through if nested in
  // params.rules. Promote them to top-level params so the LLM's "next Monday"
  // intent actually lands in the link rules (and gets respected by the
  // scoring engine's dateRange filter).
  const preferredDays = Array.isArray(params.preferredDays) ? params.preferredDays : undefined;
  let dateRange: { start?: string; end?: string } | undefined =
    params.dateRange && typeof params.dateRange === "object" && !Array.isArray(params.dateRange)
      ? (params.dateRange as { start?: string; end?: string })
      : undefined;

  // Safety net: when the host signals urgency ("asap") with a specific day
  // preference but the LLM didn't emit a concrete dateRange, constrain to the
  // next 14 days in host timezone. This prevents "find time with X next Monday"
  // from being interpreted as "all Mondays for the next 3 months."
  if (!dateRange && urgency === "asap" && preferredDays && preferredDays.length > 0) {
    const userRow2 = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    const hostTz = getUserTimezone(userRow2?.preferences as Record<string, unknown> | null);
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: hostTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const today = dateFmt.format(new Date());
    const plus14 = dateFmt.format(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000));
    dateRange = { start: today, end: plus14 };
  }

  // guestPicks / guestGuidance (2026-04-17): capture host deferrals and
  // qualitative hints. Envoy's create_link playbook is responsible for only
  // emitting these when the host explicitly defers ("he picks", "whatever
  // works for them"). `tone` runs through the flavor sanitizer here at the
  // action boundary so injection attempts can be logged server-side.
  const rawGuestPicks = params.guestPicks as Record<string, unknown> | undefined;
  const rawGuestGuidance = params.guestGuidance as Record<string, unknown> | undefined;

  // Time-of-day phrase parse — if the LLM didn't explicitly set
  // guestPicks.window but the host used "morning/afternoon/evening", fill it
  // in. Keeps the semantic anchored to the host's timezone at offer time.
  const timePhrase = parseTimeOfDay(urgency)
    || parseTimeOfDay(topic)
    || parseTimeOfDay((params.rationale as string | undefined) || "");
  let guestPicksOut: Record<string, unknown> | undefined;
  if (rawGuestPicks && typeof rawGuestPicks === "object") {
    guestPicksOut = { ...rawGuestPicks };
    if (!guestPicksOut.window && timePhrase) guestPicksOut.window = timePhrase;
  } else if (timePhrase) {
    // Host used a time-of-day phrase without explicit deferral flags. The
    // window alone is enough to clamp the offer — no guest-picks implied.
    guestPicksOut = { window: timePhrase };
  }

  // Sanitize the guidance payload before it's persisted anywhere.
  let guidanceOut: Record<string, unknown> | undefined;
  if (rawGuestGuidance && typeof rawGuestGuidance === "object") {
    const cleaned: Record<string, unknown> = {};
    const sugSrc = rawGuestGuidance.suggestions as Record<string, unknown> | undefined;
    if (sugSrc && typeof sugSrc === "object") {
      const sug: Record<string, unknown> = {};
      const locs = sanitizeSuggestionList(sugSrc.locations);
      if (locs.length) sug.locations = locs;
      if (Array.isArray(sugSrc.durations)) {
        const durs = sugSrc.durations.filter((d): d is number => typeof d === "number" && d > 0);
        if (durs.length) sug.durations = durs;
      }
      if (Object.keys(sug).length) cleaned.suggestions = sug;
    }
    if (typeof rawGuestGuidance.tone === "string") {
      const result = sanitizeHostFlavor(rawGuestGuidance.tone);
      if (result.rejected) {
        console.warn(
          `[create_link] host flavor rejected (${result.reason}) — raw: ${JSON.stringify(result.raw).slice(0, 200)}`
        );
      } else if (result.safe) {
        cleaned.tone = result.safe;
      }
    }
    if (Object.keys(cleaned).length) guidanceOut = cleaned;
  }

  const linkRules = normalizeLinkRules({
    ...rules,
    ...(format ? { format } : {}),
    ...(params.duration ? { duration: params.duration } : {}),
    ...(urgency ? { urgency } : {}),
    ...(isVip ? { isVip: true } : {}),
    ...(allowWeekends ? { allowWeekends: true } : {}),
    ...(preferredTimeStart ? { preferredTimeStart } : {}),
    ...(preferredTimeEnd ? { preferredTimeEnd } : {}),
    ...(preferredDays ? { preferredDays } : {}),
    ...(dateRange ? { dateRange } : {}),
    ...(location ? { location } : {}),
    ...(activity ? { activity } : {}),
    ...(activityIcon ? { activityIcon } : {}),
    ...(timingLabel ? { timingLabel } : {}),
    ...(guestPicksOut ? { guestPicks: guestPicksOut } : {}),
    ...(guidanceOut ? { guestGuidance: guidanceOut } : {}),
  });
  // Silence unused-import warnings for constants referenced only in playbooks.
  void TIME_OF_DAY_WINDOWS;

  const link = await prisma.negotiationLink.create({
    data: {
      userId,
      type: "contextual",
      slug: meetSlug,
      code,
      inviteeName,
      inviteeEmail,
      inviteeTimezone,
      topic,
      hostNote,
      rules: linkRules as Parameters<typeof prisma.negotiationLink.create>[0]["data"]["rules"],
    },
  });

  // Session display title. When no topic was specified, use "HostFirst + GuestName"
  // so the dashboard shows something meaningful instead of a generic "Catch up".
  // hostName was fetched above in the combined slug+name lookup.
  const hostFirstName = hostName?.split(/\s+/)[0] || "Host";
  const title = topic
    ? `${topic} — ${inviteeName || "Invitee"}`
    : inviteeName
    ? `${hostFirstName} + ${inviteeName}`
    : `Meeting — ${hostFirstName}`;

  const session = await prisma.negotiationSession.create({
    data: {
      linkId: link.id,
      hostId: userId,
      type: "calendar",
      status: "active",
      title,
      statusLabel: `Waiting for ${inviteeName || "invitee"}`,
      format,
      duration: (params.duration as number) || 30,
    },
  });

  const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
  const url = `${baseUrl}/meet/${meetSlug}/${code}`;

  return {
    success: true,
    message: `Created link for ${inviteeName || "invitee"}${topic ? ` (${topic})` : ""}`,
    data: {
      sessionId: session.id,
      linkId: link.id,
      code,
      url,
      title,
    },
  };
}

async function handleUpdateKnowledge(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const persistent = params.persistent as string | undefined;
  const situational = params.situational as string | undefined;
  const blockedWindows = params.blockedWindows as Array<{
    start: string;
    end: string;
    days?: string[];
    label?: string;
    expires?: string;
  }> | undefined;
  const currentLocation = params.currentLocation as {
    label: string;
    until?: string; // ISO date "2026-04-14" — clears automatically after this date
  } | null | undefined;

  if (!persistent && !situational && !blockedWindows && currentLocation === undefined) {
    return { success: false, message: "Missing knowledge, blockedWindows, or currentLocation to update" };
  }

  const updateData: Record<string, unknown> = {};
  if (persistent !== undefined) updateData.persistentKnowledge = persistent;
  if (situational !== undefined) updateData.upcomingSchedulePreferences = situational;
  const calibratedAt = new Date();
  logCalibrationWrite({ userId, value: calibratedAt, source: "agent-update-knowledge" });
  updateData.lastCalibratedAt = calibratedAt;

  // Merge blocked windows + currentLocation into preferences.explicit
  if ((blockedWindows && blockedWindows.length > 0) || currentLocation !== undefined) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    const prefs = (user?.preferences as Record<string, unknown>) || {};
    const explicit = (prefs.explicit as Record<string, unknown>) || {};

    let newExplicit = { ...explicit };

    if (blockedWindows && blockedWindows.length > 0) {
      const existing = (explicit.blockedWindows as typeof blockedWindows) || [];
      // Deduplicate: match on start+end+days combo
      const merged = [...existing];
      for (const newWindow of blockedWindows) {
        const daysKey = newWindow.days?.sort().join(",") ?? "all";
        const exists = merged.some(
          (w) =>
            w.start === newWindow.start &&
            w.end === newWindow.end &&
            (w.days?.sort().join(",") ?? "all") === daysKey
        );
        if (!exists) merged.push(newWindow);
      }
      newExplicit = { ...newExplicit, blockedWindows: merged };
    }

    if (currentLocation !== undefined) {
      // Location is now stored as an availability rule with action: "location".
      // null clears the active location rule(s); object upserts a new one.
      const existingRules = (newExplicit.structuredRules as AvailabilityRule[] | undefined) ?? [];
      if (currentLocation === null) {
        // Remove any active location rules
        const filtered = existingRules.filter(
          (r) => !(r.action === "location" && r.status === "active")
        );
        newExplicit = { ...newExplicit, structuredRules: filtered };
      } else {
        // Deactivate any existing active location rules, append a new one
        const deactivated = existingRules.map((r) =>
          r.action === "location" && r.status === "active"
            ? ({ ...r, status: "paused" as const })
            : r
        );
        const newRule: AvailabilityRule = {
          id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          originalText: currentLocation.until
            ? `Currently in ${currentLocation.label} until ${currentLocation.until}`
            : `Currently in ${currentLocation.label}`,
          type: currentLocation.until ? "temporary" : "ongoing",
          action: "location",
          locationLabel: currentLocation.label,
          expiryDate: currentLocation.until,
          status: "active",
          priority: 3,
          createdAt: new Date().toISOString(),
        };
        newExplicit = { ...newExplicit, structuredRules: [...deactivated, newRule] };
      }
      // Drop legacy key if present
      const { currentLocation: _legacy, ...rest } = newExplicit as Record<string, unknown>;
      void _legacy;
      newExplicit = rest;
    }

    updateData.preferences = {
      ...prefs,
      explicit: newExplicit,
    };
  }

  await prisma.user.update({
    where: { id: userId },
    data: updateData as Parameters<typeof prisma.user.update>[0]["data"],
  });

  // Invalidate computed schedule when preferences/knowledge change
  // (next request will recompute with fresh inputs)
  if (blockedWindows || currentLocation !== undefined || persistent) {
    const { invalidateSchedule } = await import("@/lib/calendar");
    await invalidateSchedule(userId);
  }

  const parts: string[] = [];
  if (persistent) parts.push("scheduling knowledge");
  if (situational) parts.push("upcoming schedule context");
  if (blockedWindows) parts.push(`${blockedWindows.length} blocked window(s)`);
  if (currentLocation !== undefined) {
    parts.push(currentLocation === null ? "cleared current location" : `current location: ${currentLocation.label}`);
  }

  return {
    success: true,
    message: `Updated ${parts.join(" and ")} (knowledge base)`,
  };
}

/**
 * Save host meeting settings (phone, video provider, zoom link, default duration)
 * to user.preferences. Used when the host supplies one of these mid-negotiation
 * (e.g., drops a phone number into chat for a phone call).
 *
 * Writes at the top level of preferences (not inside `explicit`), matching the
 * /api/agent/knowledge PUT contract so the account page + confirm route + composer
 * all read the same values. The confirm route reads hostPrefs.phone fresh at
 * confirm-time, so saving here auto-applies to any pending (unconfirmed) invites.
 */
async function handleUpdateMeetingSettings(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const phone = params.phone as string | undefined;
  const videoProvider = params.videoProvider as string | undefined;
  const zoomLink = params.zoomLink as string | undefined;
  const defaultDuration = params.defaultDuration as number | undefined;

  if (
    phone === undefined &&
    videoProvider === undefined &&
    zoomLink === undefined &&
    defaultDuration === undefined
  ) {
    return { success: false, message: "No meeting settings to update" };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const currentPrefs = (user?.preferences as Record<string, unknown>) || {};

  const updates: Record<string, unknown> = { ...currentPrefs };
  const changed: string[] = [];
  if (phone !== undefined) {
    updates.phone = phone || null;
    changed.push(phone ? `phone: ${phone}` : "cleared phone");
  }
  if (videoProvider !== undefined) {
    updates.videoProvider = videoProvider || "google-meet";
    changed.push(`video provider: ${videoProvider}`);
  }
  if (zoomLink !== undefined) {
    updates.zoomLink = zoomLink || null;
    changed.push(zoomLink ? `zoom link saved` : "cleared zoom link");
  }
  if (defaultDuration !== undefined) {
    updates.defaultDuration = defaultDuration || 30;
    changed.push(`default duration: ${defaultDuration} min`);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      preferences: updates as unknown as Parameters<typeof prisma.user.update>[0]["data"]["preferences"],
    },
  });

  return {
    success: true,
    message: `Saved to settings — ${changed.join(", ")}`,
  };
}

async function handleSaveGuestInfo(
  params: Record<string, unknown>,
  userId: string,
  sessionId?: string
): Promise<ActionResult> {
  const guestName = params.guestName as string | undefined;
  const guestEmail = params.guestEmail as string | undefined;
  const topic = params.topic as string | undefined;

  if (!guestName && !guestEmail && !topic) {
    return { success: false, message: "No guest info to save" };
  }

  if (!sessionId) {
    return { success: false, message: "No session context" };
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: { linkId: true, hostId: true, guestEmail: true },
  });

  if (!session || session.hostId !== userId) {
    return { success: false, message: "Session not found or unauthorized" };
  }

  // Update the link with guest info (so it persists to event card, calendar events, etc.)
  const linkUpdate: Record<string, unknown> = {};
  if (guestName) linkUpdate.inviteeName = guestName;
  if (guestEmail) linkUpdate.inviteeEmail = guestEmail;
  if (topic) linkUpdate.topic = topic;

  await prisma.negotiationLink.update({
    where: { id: session.linkId },
    data: linkUpdate as Parameters<typeof prisma.negotiationLink.update>[0]["data"],
  });

  // Also save guestEmail on the session if not already set
  if (guestEmail && !session.guestEmail) {
    await prisma.negotiationSession.update({
      where: { id: sessionId },
      data: { guestEmail },
    });
  }

  const parts: string[] = [];
  if (guestName) parts.push(`name: ${guestName}`);
  if (guestEmail) parts.push(`email: ${guestEmail}`);
  if (topic) parts.push(`topic: ${topic}`);

  return {
    success: true,
    message: `Saved guest info — ${parts.join(", ")}`,
  };
}

/**
 * Expand or downgrade the priority/rules of an existing negotiation link.
 *
 * Lookup:
 *   - `code`: string — the 6-char link code from the URL
 *   - OR `sessionId`: string — the deal-room session id (we walk to its link)
 *
 * Mutations (all optional; provide the ones you want to change):
 *   - `isVip`: boolean — flag the link as a VIP meeting. Toggles Envoy's
 *     proactive expansion question, reactive stretch reach, and tentative
 *     hold mechanic. Does NOT auto-unlock protected hours on its own.
 *   - `preferredTimeStart` / `preferredTimeEnd`: "HH:MM" — widens the daily
 *     offering window. Score 3-4 off-hours slots inside this range become
 *     first-offer (explicit host authorization).
 *   - `allowWeekends`: boolean — explicitly allow weekend daytime slots in
 *     the first-offer set for this link.
 *   - `dateRange`: { start?, end? } — YYYY-MM-DD host-local inclusive.
 *   - `preferredDays`, `lastResort`: day-name arrays (normalized on write).
 *
 * Supports both upgrade and downgrade. Rules merge — an explicit
 * `isVip: false` will overwrite an existing `true`.
 */
async function handleExpandLink(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const code = (params.code as string) || null;
  // Resolve placeholder sessionIds (e.g. "LAST_CREATED") before lookup — but
  // ONLY when the caller actually passed a sessionId. expand_link is a
  // code-identifier tool; silently falling back to "latest session for user"
  // when neither code nor sessionId was given would bypass the required-arg
  // guard below and misroute to an unrelated link. (Regression caught
  // 2026-04-20 by agent-actions.test.ts "rejects when no identifying code
  // or sessionId provided".)
  const rawSessionIdParam = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  const resolvedSessionId = !code && rawSessionIdParam
    ? await resolveSessionId(params, userId)
    : null;
  const sessionId = code ? null : (resolvedSessionId ?? null);

  if (!code && !sessionId) {
    return {
      success: false,
      message: "expand_link requires either a `code` (link code) or `sessionId`",
    };
  }

  // Resolve link by code (preferred) or via session.linkId.
  let link: { id: string; userId: string; rules: unknown; inviteeName: string | null; code: string | null } | null = null;
  let resolvedSessionIdForLink: string | null = sessionId || null;
  if (code) {
    link = await prisma.negotiationLink.findFirst({
      where: { code, userId },
      select: { id: true, userId: true, rules: true, inviteeName: true, code: true },
    });
    // For "View it here" threading: find the most recent session on this link.
    if (link) {
      const latest = await prisma.negotiationSession.findFirst({
        where: { linkId: link.id, archived: false },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latest) resolvedSessionIdForLink = latest.id;
    }
    // Fallback (narration-hygiene-v2, 2026-04-20): if `code` didn't resolve
    // but the caller supplied a sessionId context AND the LLM might have
    // fabricated/mistyped the code, try the session's linkId before
    // returning "Link not found". Root cause of 2026-04-20 host-feed update
    // failure: LLM reached for update_link on a bike-ride link but emitted
    // a code that didn't match.
    if (!link && rawSessionIdParam) {
      const fallbackSessionId = await resolveSessionId(params, userId);
      if (fallbackSessionId) {
        const fallbackSession = await prisma.negotiationSession.findUnique({
          where: { id: fallbackSessionId },
          select: {
            hostId: true,
            link: { select: { id: true, userId: true, rules: true, inviteeName: true, code: true } },
          },
        });
        if (fallbackSession && fallbackSession.hostId === userId && fallbackSession.link) {
          link = fallbackSession.link;
          resolvedSessionIdForLink = fallbackSessionId;
          console.log(`[expand_link] code lookup miss for "${code}" → resolved via sessionId fallback`);
        }
      }
    }
  } else if (sessionId) {
    const session = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      select: {
        hostId: true,
        linkId: true,
        link: { select: { id: true, userId: true, rules: true, inviteeName: true, code: true } },
      },
    });
    if (!session) {
      return { success: false, message: `Session not found: ${sessionId}` };
    }
    if (session.hostId !== userId) {
      return { success: false, message: "Not authorized for this session" };
    }
    link = session.link;
  }

  if (!link) {
    return { success: false, message: "Link not found" };
  }
  if (link.userId !== userId) {
    return { success: false, message: "Not authorized for this link" };
  }

  // Merge new rule fragments onto the existing rules, then normalize the
  // whole thing so day-name arrays and dateRange stay canonical even if the
  // host started from a mixed-shape row.
  const existingRules = (link.rules as Record<string, unknown>) || {};
  const patch: Record<string, unknown> = {};
  if (typeof params.isVip === "boolean") patch.isVip = params.isVip;
  if (typeof params.allowWeekends === "boolean") patch.allowWeekends = params.allowWeekends;
  if (params.preferredTimeStart !== undefined) patch.preferredTimeStart = params.preferredTimeStart;
  if (params.preferredTimeEnd !== undefined) patch.preferredTimeEnd = params.preferredTimeEnd;
  // preferredDays accepts either short-name strings ("Mon","Tue") OR a
  // numeric daysOfWeek array ([0..6], Sun=0). The LLM tends to reach for
  // `daysOfWeek` when it thinks in calendar terms — accept both and
  // normalize into preferredDays downstream via normalizeLinkRules.
  if (params.preferredDays !== undefined) patch.preferredDays = params.preferredDays;
  else if (Array.isArray(params.daysOfWeek)) {
    const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    patch.preferredDays = (params.daysOfWeek as unknown[])
      .filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
      .map((d) => DAY_NAMES[d]);
  }
  if (params.lastResort !== undefined) patch.lastResort = params.lastResort;
  if (params.dateRange !== undefined) patch.dateRange = params.dateRange;

  // V4 link-rule fields (2026-04-20): timing label + format/duration +
  // activity/activityIcon/location. All free-form; sanitized via
  // normalizeLinkRules where it applies (duration must be positive int).
  if (typeof params.timingLabel === "string") {
    const t = params.timingLabel.trim().slice(0, 80);
    patch.timingLabel = t || undefined;
  }
  if (typeof params.format === "string") {
    const f = params.format.trim().toLowerCase();
    if (f === "video" || f === "phone" || f === "in-person") patch.format = f;
  }
  if (typeof params.duration === "number") patch.duration = params.duration;
  if (typeof params.activity === "string") {
    const a = params.activity.trim().slice(0, 60);
    patch.activity = a || undefined;
  }
  if (typeof params.activityIcon === "string") {
    const ai = params.activityIcon.trim().slice(0, 8);
    patch.activityIcon = ai || undefined;
  }
  if (typeof params.location === "string") {
    const loc = params.location.trim().slice(0, 120);
    patch.location = loc || undefined;
  }

  if (Object.keys(patch).length === 0) {
    return {
      success: false,
      message: "update_link needs at least one field to change (isVip, allowWeekends, preferredTimeStart/End, preferredDays/daysOfWeek, lastResort, dateRange, timingLabel, format, duration, activity, activityIcon, location)",
    };
  }

  const mergedRules = normalizeLinkRules({ ...existingRules, ...patch });

  await prisma.negotiationLink.update({
    where: { id: link.id },
    data: {
      rules: mergedRules as Parameters<typeof prisma.negotiationLink.update>[0]["data"]["rules"],
    },
  });

  // Human-readable confirmation message.
  const changedParts: string[] = [];
  if (patch.isVip !== undefined) {
    changedParts.push(`VIP: ${patch.isVip ? "on" : "off"}`);
  }
  if (patch.allowWeekends !== undefined) {
    changedParts.push(`weekends: ${patch.allowWeekends ? "allowed" : "off"}`);
  }
  if (patch.preferredTimeStart !== undefined || patch.preferredTimeEnd !== undefined) {
    const start = patch.preferredTimeStart ?? existingRules.preferredTimeStart ?? "—";
    const end = patch.preferredTimeEnd ?? existingRules.preferredTimeEnd ?? "—";
    changedParts.push(`window: ${start}–${end}`);
  }
  if (patch.preferredDays !== undefined) {
    changedParts.push(`days: ${Array.isArray(patch.preferredDays) ? patch.preferredDays.join(",") : "updated"}`);
  }
  if (patch.dateRange !== undefined) {
    changedParts.push(`dateRange: updated`);
  }
  if (patch.timingLabel !== undefined) changedParts.push(`timing: ${patch.timingLabel ?? "cleared"}`);
  if (patch.format !== undefined) changedParts.push(`format: ${patch.format}`);
  if (patch.duration !== undefined) changedParts.push(`duration: ${patch.duration} min`);
  if (patch.activity !== undefined) changedParts.push(`activity: ${patch.activity ?? "cleared"}`);
  if (patch.location !== undefined) changedParts.push(`location: ${patch.location ?? "cleared"}`);

  // Post-edit follow-up: drop a short administrator message into every
  // active session on this link so the guest's deal-room shows what
  // changed since they last looked. Intentionally an additive message
  // (not a greeting rewrite) — honors the chat-history model: what was
  // offered before still appears above, the update is news.
  try {
    const activeSessions = await prisma.negotiationSession.findMany({
      where: { linkId: link.id, status: { in: ["active", "pending"] } },
      select: { id: true },
    });
    if (activeSessions.length > 0) {
      const hostFirstName = (await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      }))?.name?.split(/\s+/)[0] ?? "The host";
      const followupParts: string[] = [];
      if (patch.preferredDays !== undefined && Array.isArray(patch.preferredDays)) {
        const days = (patch.preferredDays as string[]).join(", ");
        followupParts.push(days ? `available days updated to ${days}` : "available days cleared");
      }
      if (patch.dateRange !== undefined) followupParts.push("date range updated");
      if (patch.timingLabel !== undefined && patch.timingLabel) {
        followupParts.push(`timing now "${patch.timingLabel}"`);
      }
      if (patch.format !== undefined) followupParts.push(`format now ${patch.format}`);
      if (patch.duration !== undefined) followupParts.push(`duration now ${patch.duration} min`);
      if (patch.activity !== undefined && patch.activity) followupParts.push(`activity now "${patch.activity}"`);
      if (patch.location !== undefined && patch.location) followupParts.push(`location now ${patch.location}`);
      if (patch.preferredTimeStart !== undefined || patch.preferredTimeEnd !== undefined) {
        followupParts.push("time window updated");
      }
      if (followupParts.length > 0) {
        const msg = `${hostFirstName} updated the proposal — ${followupParts.join("; ")}. Let me know if this changes anything on your side.`;
        await Promise.all(
          activeSessions.map((s) =>
            prisma.message.create({
              data: {
                sessionId: s.id,
                role: "administrator",
                content: msg,
                metadata: { kind: "host_update", field: "link_rules" } as Prisma.InputJsonValue,
              },
            })
          )
        );
      }
    }
  } catch (e) {
    console.error("[update_link] follow-up message insert failed (non-blocking):", e);
  }

  const name = link.inviteeName || link.code;
  return {
    success: true,
    message: `Updated ${name}'s link — ${changedParts.join(", ")}`,
    data: { linkId: link.id, code: link.code, rules: mergedRules, sessionId: resolvedSessionIdForLink ?? undefined },
  };
}

// --- Tentative hold actions (VIP stretch protection) ---

const HOLD_TTL_HOURS = 48;

/**
 * Place a tentative hold on a specific stretch slot, explicitly authorized
 * by the host in the dashboard thread. Creates a Hold row AND a tentative
 * event on the host's calendar (when calendar is writable) to prevent
 * concurrent bookings from grabbing the slot while the guest decides.
 *
 * Required params:
 *   - sessionId: the deal-room session the hold is protecting
 *   - slotStart / slotEnd: ISO datetimes of the 30-min slot
 * Optional:
 *   - ttlHours: override the default 48h expiry
 *   - label: shown on the calendar tentative event (default uses the
 *     session's inviteeName)
 *
 * The hold's `status` progresses: active → satisfied (when the meeting is
 * confirmed), released (when the host explicitly unholds), or expired
 * (when the 48h TTL elapses with no resolution). A background sweeper
 * will flip active → expired when expiresAt < now; that sweeper is wired
 * in a separate commit.
 */
async function handleHoldSlot(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const sessionId = await resolveSessionId(params, userId);
  const slotStartRaw = params.slotStart as string | undefined;
  const slotEndRaw = params.slotEnd as string | undefined;
  const ttlHours = typeof params.ttlHours === "number" && params.ttlHours > 0
    ? params.ttlHours
    : HOLD_TTL_HOURS;

  if (!sessionId || !slotStartRaw || !slotEndRaw) {
    return {
      success: false,
      message: "hold_slot requires sessionId, slotStart, and slotEnd",
    };
  }

  const slotStart = new Date(slotStartRaw);
  const slotEnd = new Date(slotEndRaw);
  if (isNaN(slotStart.getTime()) || isNaN(slotEnd.getTime())) {
    return { success: false, message: "Invalid slotStart or slotEnd ISO datetime" };
  }
  if (slotEnd <= slotStart) {
    return { success: false, message: "slotEnd must be after slotStart" };
  }

  // Authorize: the session must belong to the acting user.
  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      hostId: true,
      link: { select: { inviteeName: true, code: true } },
    },
  });
  if (!session) {
    return { success: false, message: `Session not found: ${sessionId}` };
  }
  if (session.hostId !== userId) {
    return { success: false, message: "Not authorized for this session" };
  }

  // Reject if there's already an active hold on the same slot for this session.
  const existing = await prisma.hold.findFirst({
    where: {
      sessionId,
      slotStart,
      slotEnd,
      status: "active",
    },
  });
  if (existing) {
    return {
      success: false,
      message: "A hold is already active on this slot for this session",
      data: { holdId: existing.id },
    };
  }

  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  // Create the Hold row first — it's the source of truth. The calendar
  // tentative event is a best-effort side effect; if the host has no
  // writable calendar (or gcal is temporarily unreachable), the hold still
  // exists in our DB and the composer/widget will respect it.
  const hold = await prisma.hold.create({
    data: {
      sessionId,
      hostId: userId,
      slotStart,
      slotEnd,
      status: "active",
      expiresAt,
    },
  });

  // Create the backing tentative calendar event. Non-blocking on failure —
  // the Hold row is authoritative. If this succeeds, persist the gcal id
  // so handleReleaseHold can clean it up later.
  const guestName = session.link.inviteeName || "guest";
  try {
    const result = await createTentativeHoldEvent(userId, {
      summary: `[HOLD] ${guestName}`,
      description: `Tentative hold placed by AgentEnvoy. Expires ${expiresAt.toISOString()} unless confirmed or released.`,
      startTime: slotStart,
      endTime: slotEnd,
    });
    if (result.eventId) {
      await prisma.hold.update({
        where: { id: hold.id },
        data: { calendarEventId: result.eventId },
      });
    }
  } catch (e) {
    console.warn("[hold_slot] could not create tentative calendar event:", e);
  }

  // Post a system message into the negotiation session so the host channel
  // has an auditable record of when + why the hold was placed.
  await prisma.message.create({
    data: {
      sessionId,
      role: "system",
      content: `Held ${slotStart.toISOString()} for ${session.link.inviteeName ?? "the guest"}. Expires in ${ttlHours}h.`,
    },
  });

  const name = session.link.inviteeName || session.link.code || "the guest";
  return {
    success: true,
    message: `Held ${slotStart.toISOString().slice(0, 16)} for ${name}. Expires in ${ttlHours}h or when confirmed.`,
    data: { holdId: hold.id, sessionId, expiresAt: expiresAt.toISOString() },
  };
}

/**
 * Release a tentative hold previously placed via hold_slot. Marks the Hold
 * row `released` and triggers deletion of the backing calendar tentative
 * event (the calendar side-effect is a follow-up commit; for now we just
 * flip the status).
 *
 * Required: sessionId. Optional: slotStart (to target a specific hold when
 * multiple exist on the same session; omit to release all active holds on
 * the session).
 */
async function handleReleaseHold(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const sessionId = await resolveSessionId(params, userId);
  const slotStartRaw = params.slotStart as string | undefined;

  if (!sessionId) {
    return { success: false, message: "release_hold requires sessionId" };
  }

  // Authorize
  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      hostId: true,
      link: { select: { inviteeName: true, code: true } },
    },
  });
  if (!session) {
    return { success: false, message: `Session not found: ${sessionId}` };
  }
  if (session.hostId !== userId) {
    return { success: false, message: "Not authorized for this session" };
  }

  const where: NonNullable<Parameters<typeof prisma.hold.findMany>[0]>["where"] = {
    sessionId,
    status: "active",
  };
  if (slotStartRaw) {
    const slotStart = new Date(slotStartRaw);
    if (isNaN(slotStart.getTime())) {
      return { success: false, message: "Invalid slotStart ISO datetime" };
    }
    where.slotStart = slotStart;
  }

  // Fetch the matching active holds first so we can clean up each one's
  // tentative calendar event. We then mark them released in a single update.
  const holdsToRelease = await prisma.hold.findMany({
    where,
    select: { id: true, calendarEventId: true },
  });

  if (holdsToRelease.length === 0) {
    return {
      success: false,
      message: slotStartRaw
        ? `No active hold found for session ${sessionId} at ${slotStartRaw}`
        : `No active holds found for session ${sessionId}`,
    };
  }

  // Delete each backing tentative calendar event. Non-blocking per hold —
  // a gcal failure shouldn't leave the hold in a half-released state.
  await Promise.all(
    holdsToRelease.map(async (h) => {
      if (!h.calendarEventId) return;
      try {
        await deleteCalendarEvent(userId, h.calendarEventId);
      } catch (e) {
        console.warn(`[release_hold] could not delete tentative event ${h.calendarEventId}:`, e);
      }
    })
  );

  const result = await prisma.hold.updateMany({
    where,
    data: { status: "released" },
  });

  const name = session.link.inviteeName || session.link.code || "the guest";
  return {
    success: true,
    message: `Released ${result.count} hold${result.count === 1 ? "" : "s"} for ${name}.`,
    data: { sessionId, releasedCount: result.count },
  };
}
