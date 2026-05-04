import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateCode } from "@/lib/utils";
import { getUserTimezone, shortTimezoneLabel } from "@/lib/timezone";
import type { AvailabilityPreference } from "@/lib/availability-rules";
import { normalizeLinkParameters } from "@/lib/scoring";
import {
  deriveLegacy,
  hasMaterialNarrowingChange,
  normalizeSteering,
  readStoredSteering,
  validateIntent,
  type Steering,
} from "@/lib/intent";
import { createTentativeHoldEvent, deleteCalendarEvent } from "@/lib/calendar";
import { cancelSession } from "@/lib/cancel-pipeline";
import { parseTimeOfDay, TIME_OF_DAY_WINDOWS } from "@/lib/time-of-day";
import { sanitizeHostFlavor, sanitizeSuggestionList } from "@/lib/host-flavor-sanitizer";
import { logCalibrationWrite } from "@/lib/calibration-audit";
import { formatDuration } from "@/lib/format-duration";
import { writeProfileField } from "@/lib/profile-fields";
import { hostFirstName as resolveHostFirstName } from "@/lib/host-naming";
import { invalidateBehaviorSnapshot } from "@/lib/profile-gaps";
import { parseRecurrence, readRecurrence, type LinkRecurrence } from "@/lib/recurrence";
import type { UserPreferences } from "@/lib/scoring";
import { parseLinkParameters } from "@/lib/link-parameters";
import { snapshotPostureFromUser } from "@/lib/links/create";
import {
  GUEST_PICKS_DURATION_MIN_MINUTES,
  GUEST_PICKS_DURATION_MAX_MINUTES,
} from "@/lib/mcp/parameter-resolver";
import { isGenericTopic, findActivity, defaultDurationForActivity } from "@/lib/activity-vocab";
import { MATERIAL_FIELDS, type MaterialField } from "@/lib/material-fields";

// --- Helpers ---
//
// GENERIC_TOPICS / isGenericTopic moved to @/lib/activity-vocab in the
// 2026-04-28 event-edit proposal (Q3 fold) so the canonical list has one
// home. See proposals/2026-04-28_event-edit-unified-intent_*_decided-2026-04-28.md.

/**
 * Derive `topicSource` provenance at write time.
 *  - null (no topic)              → null
 *  - matches activity vocab       → "activity"   (vocab name OR alias)
 *  - generic filler (filtered)    → null         (topic itself was nulled out)
 *  - anything else                → "custom"     (host-given non-vocab phrase)
 */
function deriveTopicSource(topic: string | null): "activity" | "custom" | null {
  if (!topic) return null;
  if (findActivity(topic)) return "activity";
  return "custom";
}

/**
 * Validate the `blockedRanges` patch payload from the LLM. Returns the
 * sanitized array or throws via the returned error message.
 *
 * Rules:
 *  - Array of `{start, end}` strings (ISO 8601). Length ≤ 10.
 *  - `start < end` (chronologically) — otherwise reject.
 *  - Both strings parse as valid Dates — otherwise reject.
 *
 * The LLM is responsible for resolving ambiguous date phrasing (e.g.
 * "Thursday") against the link's `dateRange` BEFORE emitting the action;
 * the handler here is purely structural validation.
 */
function validateBlockedRanges(
  input: unknown,
): { ok: true; ranges: Array<{ start: string; end: string }> } | { ok: false; reason: string } {
  if (!Array.isArray(input)) return { ok: false, reason: "blockedRanges must be an array" };
  if (input.length > 10) return { ok: false, reason: "blockedRanges may not exceed 10 entries" };
  const ranges: Array<{ start: string; end: string }> = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: "each blockedRanges entry must be an object" };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.start !== "string" || typeof e.end !== "string") {
      return { ok: false, reason: "blockedRanges entries need string start/end" };
    }
    const startMs = Date.parse(e.start);
    const endMs = Date.parse(e.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return { ok: false, reason: `blockedRanges has unparseable date: ${e.start} / ${e.end}` };
    }
    if (startMs >= endMs) {
      return { ok: false, reason: `blockedRanges entry has start >= end: ${e.start} / ${e.end}` };
    }
    ranges.push({ start: e.start, end: e.end });
  }
  return { ok: true, ranges };
}

/**
 * Compute the set of MaterialField names whose value changed between `prior`
 * and `next`. Used by `update_link` to populate `lastMaterialEditAt` /
 * `lastEditedFields` so the "Edited just now — activity, hours" pill renders
 * with the right field labels.
 *
 * Comparison is shallow (===) on primitives; for objects/arrays it falls
 * back to JSON.stringify. Order-sensitive — `["Mon","Tue"]` ≠ `["Tue","Mon"]`.
 * That's fine: the LLM emits a normalized order via normalizeLinkParameters
 * and the comparison is for "did anything change," not "are these
 * semantically equivalent."
 */
function diffMaterialFields(
  prior: Record<string, unknown>,
  next: Record<string, unknown>,
): MaterialField[] {
  const changed: MaterialField[] = [];
  for (const field of MATERIAL_FIELDS) {
    const a = prior[field];
    const b = next[field];
    if (a === b) continue;
    // Both primitive-ish; if structurally identical via JSON, skip.
    try {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
    } catch {
      // fall through — treat as changed
    }
    changed.push(field);
  }
  return changed;
}

/**
 * Compute a session title from the inputs that contribute to it. Pure
 * function — no DB. Mirrors the title shape that the existing invitee-swap
 * branch wrote, lifted here so activity-only edits can rebuild titles too.
 *
 * `activity` is the lowercase vocab phrase (`"bike ride"`); the function
 * capitalizes it for display. `format` is "phone" | "video" | "in-person"
 * | null.
 */
function computeSessionTitle(opts: {
  activity: string | null;
  format: string | null;
  inviteeDisplay: string | null;
  firstNamesDisplay: string;
  isGroup: boolean;
  hostFirstName: string;
}): string {
  const { activity, format, inviteeDisplay, firstNamesDisplay, isGroup, hostFirstName } = opts;
  const activityLabel = activity && activity.trim()
    ? activity.charAt(0).toUpperCase() + activity.slice(1)
    : null;
  const formatPrefix = format === "phone" ? "Call" : format === "video" ? "VC" : null;
  const prefix = activityLabel ?? formatPrefix;
  if (isGroup) {
    return prefix ? `${prefix} (${firstNamesDisplay})` : firstNamesDisplay || "Meeting";
  }
  if (!inviteeDisplay) return prefix ?? "Meeting";
  return prefix ? `${prefix}: ${inviteeDisplay} + ${hostFirstName}` : `${inviteeDisplay} + ${hostFirstName}`;
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
  silent?: boolean; // true = do not surface this result in the chat thread
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
 *
 * Optional `onActionStart` is called synchronously just before each action runs.
 * Channel-chat uses it to emit `executing` progress frames (proposal 2026-04-21).
 * Callback errors are caught and logged — they never block action execution.
 */
export async function executeActions(
  actions: ActionRequest[],
  userId: string,
  context?: { sessionId?: string; meetSlug?: string; onActionStart?: (action: ActionRequest, index: number) => void }
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (context?.onActionStart) {
      try { context.onActionStart(action, i); } catch (e) { console.error("onActionStart cb threw:", e); }
    }
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
    case "update_business_hours":
      return handleUpdateBusinessHours(action.params, userId);
    case "update_availability_rule":
      return handleUpdateAvailabilityRule(action.params, userId);
    case "save_guest_info":
      return handleSaveGuestInfo(action.params, userId, context?.sessionId);
    case "lock_activity_location":
      return handleLockActivityLocation(action.params, userId, context?.sessionId);
    case "lock_session_duration":
      return handleLockSessionDuration(action.params, userId, context?.sessionId);
    default:
      return { success: false, message: `Unknown action: ${action.action}` };
  }
}

// --- Authorization helper ---

async function getAuthorizedSession(sessionId: unknown, userId: string): Promise<ActionResult | { session: { id: string; hostId: string; status: string; title: string | null; linkId: string; calendarEventId: string | null; archived: boolean; guestEmail: string | null; guestName: string | null; link: { id: string; type: string; inviteeName: string | null; topic: string | null; parameters: unknown } } }> {
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
          parameters: true,
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
 * change to `link.parameters` so a future guest sees the right offer.
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
 * Patch link.parameters with a partial change — ONLY for personalized links
 * (one link = one session, so the update is intent-aligned). For primary
 * links (one link, many sessions) we skip the write so a dashboard tweak
 * for one guest doesn't retroactively change every future guest's
 * experience on the same shared link.
 *
 * Historical bug (pre-2026-04-18): update_format / update_location /
 * update_time handlers only mutated NegotiationSession.* fields, but the
 * greeting template + confirm route read from `link.parameters.*` FIRST. The
 * result: dashboard chat said "Updated format to in-person" and the deal
 * room kept showing the original video format. This helper exists to
 * keep the two fields in lockstep going forward.
 */
async function patchLinkRulesForContextual(
  link: { id: string; type: string; parameters: unknown },
  changes: Record<string, unknown>,
): Promise<void> {
  if (link.type !== "personalized") return;
  const existing = parseLinkParameters(link.parameters);
  const next: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  await prisma.negotiationLink.update({
    where: { id: link.id },
    data: { parameters: next as Parameters<typeof prisma.negotiationLink.update>[0]["data"]["parameters"] },
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
    where.status = { in: ["active", "proposed", "retime_proposed", "escalated"] };
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

  // Historically this path only flipped DB state — leaving live Google
  // events and active holds in place when the agent cancelled on the host's
  // behalf. Now routed through the shared cancelSession() pipeline so the
  // cascade matches the host-UI route exactly. initiator="agent" drives the
  // system-message + statusLabel wording.
  const reasonParam =
    typeof params.reason === "string" && params.reason.trim().length > 0
      ? (params.reason as string)
      : null;

  const hostUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });

  const result = await cancelSession({
    sessionId: session.id,
    hostId: userId,
    initiator: "agent",
    initiatorName: hostUser?.name ?? null,
    note: reasonParam,
    notifyAttendees: true,
  });

  if (!result.ok) {
    return { success: false, message: result.error ?? "Cancel failed" };
  }

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
  // AND link.parameters.format (for personalized links) so the greeting template
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
  // the duration through link.parameters + post a system message. Leave status alone.
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
        content: `Duration updated to ${formatDuration(duration)}`,
        metadata: { kind: "host_update", field: "duration" },
      },
    });
    return {
      success: true,
      message: `Updated duration to ${formatDuration(duration)}`,
      data: { sessionId: session.id, duration },
    };
  }

  // Pre-engagement guard: if no guest has engaged yet, do NOT flip the session
  // into `proposed` with a "Time change proposed by host" label — there's no
  // one to propose to. Mirror the intent into link.parameters (dateRange + duration)
  // so the first guest to land sees the right offer, and tell the LLM to stop
  // synthesizing specific times from window-shaped requests.
  if (await isPreEngagement(session)) {
    return {
      success: false,
      message:
        "This link has no engaged guest yet — use update_link (dateRange / availability / preferred / duration) to adjust the offer on the link itself. update_time should only be used after a guest has engaged, to re-propose a specific slot.",
    };
  }

  // Invariant pair (SPEC §2.3.1 + §2.3.2):
  //  - §2.3.1: clear agreedTime/agreedFormat whenever status leaves "agreed".
  //    Without this the deal-room reads stale agreed-state as "pending confirm"
  //    against the OLD slot, disabling the picker.
  //  - §2.3.2: preserve calendarEventId — when a session was previously
  //    confirmed, the live Google Calendar event MUST stay linked to the row
  //    so readers can recognize "live event exists, re-time in flight" rather
  //    than mistaking it for a never-confirmed session. Pre-fix bug: F15 /
  //    feedback report cmorbq7jl0003gw9f8lp1tv7e (2026-05-04) — see proposal
  //    2026-05-04_update-time-action-state-drift.
  // Status "retime_proposed" is distinct from "proposed" so the invariant pair
  // can be enforced cleanly: "retime_proposed" implies calendarEventId != null,
  // "proposed" makes no such guarantee.
  const updateData: Record<string, unknown> = {
    status: "retime_proposed",
    statusLabel: "Time change proposed by host",
    agreedTime: null,
    agreedFormat: null,
    // calendarEventId deliberately NOT cleared — see invariant note above.
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
  // Mirror duration into link.parameters.duration for personalized links so the
  // greeting template + confirm card reflect it. Same reason as format /
  // location — link.parameters wins the precedence chain.
  if (duration !== undefined) {
    await patchLinkRulesForContextual(session.link, { duration });
  }

  // Expand link.parameters.dateRange to include the proposed date if it falls
  // outside the current window. Without this, proposing Wed Apr 22 on a link
  // whose offer window is "Mon Apr 20" leaves the guest's slot picker stuck
  // showing Monday — the proposed slot isn't even offerable. Observed
  // 2026-04-20 on link wrv65w. Host-TZ bucketed YYYY-MM-DD, matching
  // src/lib/scoring.ts.
  {
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: hostTz,
    });
    const proposedDate = dateFmt.format(parsed as Date); // YYYY-MM-DD
    const existingRules = parseLinkParameters(session.link.parameters);
    const existingRange = (existingRules.dateRange as { start?: string; end?: string } | undefined) || undefined;
    if (existingRange && (existingRange.start || existingRange.end)) {
      const nextRange: { start?: string; end?: string } = { ...existingRange };
      if (nextRange.start && proposedDate < nextRange.start) nextRange.start = proposedDate;
      if (nextRange.end && proposedDate > nextRange.end) nextRange.end = proposedDate;
      if (nextRange.start !== existingRange.start || nextRange.end !== existingRange.end) {
        await patchLinkRulesForContextual(session.link, { dateRange: nextRange });
      }
    }
  }

  // Save a system message so the guest sees the proposal
  const durationStr = duration !== undefined ? ` (${formatDuration(duration)})` : "";
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
  // message for the thread history, AND link.parameters.location for personalized
  // links so the confirm card + GCal event actually use the new location.
  // Previously this only wrote statusLabel + a system message, leaving
  // link.parameters.location untouched — the confirm route reads link.parameters.location
  // and so silently ignored the update.
  //
  // Pre-engagement: skip the statusLabel clobber — "Location updated to X" on
  // a never-engaged draft is misleading and overrides the draft-state label.
  // Still mirror to link.parameters + post the system note so the offer is correct.
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

export async function handleCreateLink(
  params: Record<string, unknown>,
  userId: string,
  meetSlug?: string
): Promise<ActionResult> {
  // Always fetch both slug (if needed) and name in one query so the session
  // title can use "John + Guest" format. When meetSlug is already provided via
  // context we still need the name — combine into a single lookup.
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { meetSlug: true, name: true, preferences: true },
  });
  if (!meetSlug) {
    meetSlug = userRow?.meetSlug || undefined;
  }
  const hostName: string | null = userRow?.name || null;

  if (!meetSlug) {
    return { success: false, message: "No meet slug configured. Set up your profile first." };
  }

  const googleAccount = await prisma.account.findFirst({
    where: { userId, provider: "google" },
    select: { scope: true },
  });
  const calendarConnected = googleAccount?.scope?.includes("calendar") ?? false;
  if (!calendarConnected) {
    return {
      success: false,
      message:
        "sorry- i'm unable to act on this because we first need to connect your calendar.   Click the link below to do this.  It's really quick and safe and easy.",
      data: {
        error: "calendar_not_connected",
        connectUrl: "/dashboard/account",
      },
    };
  }

  const code = generateCode();
  // Accept inviteeNames[] (multi-guest) or legacy inviteeName (single string).
  // LLM should emit inviteeNames for new links; inviteeName is a shim for old prompts.
  const rawInviteeNames = params.inviteeNames;
  const inviteeNames: string[] = Array.isArray(rawInviteeNames)
    ? (rawInviteeNames as string[]).filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    : typeof params.inviteeName === "string" && (params.inviteeName as string).trim()
    ? [(params.inviteeName as string).trim()]
    : [];
  const inviteeName = inviteeNames[0] ?? null; // deprecated bridge — remove after inviteeName column drops
  const inviteeEmail = (params.inviteeEmail as string) || null;

  // Partial-attendance (Track 1, proposal 2026-04-23). Off by default — when
  // the host opts in, minimumAttendees is required and must be in [1, N-1] for
  // N invitees (1-person "partial" collapses to whole; N-person is the default).
  const rawPartial = params.partialAttendance;
  const partialAttendance: "off" | "allowed" =
    rawPartial === "allowed" ? "allowed" : "off";
  let minimumAttendees: number | null = null;
  if (partialAttendance === "allowed") {
    const raw = params.minimumAttendees;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n < 1 || (inviteeNames.length > 0 && n >= inviteeNames.length)) {
      return {
        success: false,
        message: `partialAttendance=allowed requires minimumAttendees in [1, ${Math.max(inviteeNames.length - 1, 1)}]`,
      };
    }
    minimumAttendees = n;
  }
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
  // Provenance for the title-rebuild rule on activity edits — see proposal
  // §3.B.1. "activity" → topic was activity-derived; clear/rebuild on activity
  // change. "custom" → host-set phrase like "Q3 review"; preserve.
  const topicSource = deriveTopicSource(topic);

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
  const urgency = (params.urgency as string) || null;
  // Meeting location for in-person (or phone/video where host wants to pin
  // a specific address/URL). Flows into link.parameters.location so the deal-
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
  // and `availability.restrictToDays` for actual filtering.
  const rawTimingLabel = params.timingLabel;
  const timingLabel = typeof rawTimingLabel === "string" && rawTimingLabel.trim()
    ? rawTimingLabel.trim().slice(0, 80)
    : null;
  const rules = (params.rules as Record<string, unknown>) || {};

  // Physical-activity guard (2026-04-22, feedback cmoa81lmy + cmoacqq5r).
  // When the LLM omits `format` or `location` for a physical activity (bike
  // ride, hike, etc.), the host's video default silently applies — sending
  // the guest a Google Meet invite for a bike ride. This is a code-level
  // safety net on top of the channel.md playbook rule; LLM compliance alone
  // is not reliable enough for these two fields.
  //
  // Rules:
  //   format: null + physical activity → force "in-person"
  //   location: null + guestPicks.location unset + physical activity
  //             → set guestPicks.location: true  (guest picks, not silently null)
  //
  // "Physical activity" = any activity whose primary mode is in-person and
  // non-remote. We match on a substring allowlist rather than exact strings
  // so "trail run", "morning hike", "short bike ride", etc. all hit.
  const PHYSICAL_ACTIVITY_TOKENS = [
    "bike", "hike", "run", "walk", "coffee", "lunch", "dinner",
    "breakfast", "drinks", "swim", "workout", "yoga", "trail",
  ];
  const activityLower = activity?.toLowerCase() ?? "";
  const isPhysicalActivity =
    !!activity &&
    PHYSICAL_ACTIVITY_TOKENS.some((t) => activityLower.includes(t));

  let effectiveFormat = (params.format as string) || null;
  if (isPhysicalActivity && !effectiveFormat) {
    effectiveFormat = "in-person";
    console.warn(
      `[create_link] physical activity "${activity}" had no format — defaulting to in-person`,
    );
  }

  // Activity-driven duration default (2026-04-30). When the host names a
  // canonical activity but doesn't specify a duration, use the activity's
  // sensible default from `activity-vocab.ts` (run → 60, hike → 120,
  // lunch → 60, coffee → 30, etc.) instead of falling through to the
  // global 30-min default. Solves "set up a run with John" producing a
  // 30-min run. Host's explicit `params.duration` always wins. Compose
  // cleanly with `guestPicks.duration: true` — when the host defers to
  // the guest, the activity default seeds the suggestion the guest sees
  // and they can still change it via the picker's ✏️ affordance.
  let effectiveDurationParam: number | undefined;
  if (typeof params.duration === "number") {
    effectiveDurationParam = params.duration;
  } else {
    const activityDefault = defaultDurationForActivity(activity);
    if (activityDefault != null) {
      effectiveDurationParam = activityDefault;
      console.log(
        `[create_link] activity "${activity}" → defaultDuration=${activityDefault}min`,
      );
    }
  }
  // Rebind so the rest of the handler uses the corrected value.
  // (The `format` const above is already read; we introduce effectiveFormat
  // and use it in linkRulesPreIntent below.)

  // Drift detector (2026-04-20): the channel playbook asks the LLM to populate
  // hostNote whenever the host's phrasing carries context — including
  // structured constraints expressed conversationally ("on Tuesday or
  // Wednesday next week"). If we see structured constraints set but no
  // hostNote, that's a signal the LLM forgot to carry context through.
  // Warn-only — don't block link creation. Monitor Vercel logs; if this
  // fires on real "with narrative context" cases, revisit the playbook.
  const rulesAvail = (rules as Record<string, unknown>).availability as
    | { restrictToDays?: unknown[]; restrictToWindows?: unknown[]; restrictToSlots?: unknown[]; expand?: unknown[] }
    | undefined;
  const rulesPref = (rules as Record<string, unknown>).preferred as
    | { days?: unknown[]; windows?: unknown[]; slots?: unknown[] }
    | undefined;
  const paramsAvail = (params as Record<string, unknown>).availability as typeof rulesAvail | undefined;
  const paramsPref = (params as Record<string, unknown>).preferred as typeof rulesPref | undefined;
  const nonEmpty = (a: unknown[] | undefined): boolean => Array.isArray(a) && a.length > 0;
  const hasStructuredConstraints =
    !!rules.dateRange ||
    nonEmpty(rulesAvail?.restrictToDays) ||
    nonEmpty(rulesAvail?.restrictToWindows) ||
    nonEmpty(rulesAvail?.restrictToSlots) ||
    nonEmpty(rulesAvail?.expand) ||
    nonEmpty(rulesPref?.days) ||
    nonEmpty(rulesPref?.windows) ||
    nonEmpty(rulesPref?.slots) ||
    nonEmpty(paramsAvail?.restrictToDays) ||
    nonEmpty(paramsAvail?.restrictToWindows) ||
    nonEmpty(paramsAvail?.restrictToSlots) ||
    nonEmpty(paramsAvail?.expand) ||
    nonEmpty(paramsPref?.days) ||
    nonEmpty(paramsPref?.windows) ||
    nonEmpty(paramsPref?.slots);
  if (hasStructuredConstraints && !hostNote) {
    console.warn(
      `[create_link] hostNote missing for structured constraint — invitee=${inviteeName} rules=${JSON.stringify({
        dateRange: rules.dateRange,
        availability: rulesAvail ?? paramsAvail,
        preferred: rulesPref ?? paramsPref,
      })}`,
    );
  }

  // Merge format/duration/urgency/VIP/availability/preferred into rules.
  // isVip is a binary flag — it tells Envoy she may proactively ask the host
  // about opening up stretch hours and may reach into stretch options on
  // guest pushback. isVip alone does NOT auto-unlock protected hours; the
  // host must still confirm via `availability.expand` etc.
  const isVip = params.isVip === true;
  const isDateModeLink = (effectiveDurationParam ?? 0) >= 24 * 60;
  // For date-mode links (duration ≥ 1440 min), `availability.restrictToWindows`
  // would clamp the daily slot filter to a tiny window — wrong for an
  // event-spanning concept (e.g. surf trip "noon to noon"). Drop the
  // restrictToWindows when the link is date-mode, leaving the day-level
  // `restrictToDays` and other restrictions intact.
  const rawAvailability =
    paramsAvail && typeof paramsAvail === "object" ? { ...paramsAvail } : undefined;
  if (rawAvailability && isDateModeLink) {
    delete (rawAvailability as Record<string, unknown>).restrictToWindows;
  }
  const availability = rawAvailability;
  const preferred = paramsPref && typeof paramsPref === "object" ? paramsPref : undefined;

  // Temporal date range — previously could come nested in params.rules.
  // Promote to top-level so the LLM's "next Monday" intent actually lands
  // in link rules (respected by the scoring engine's dateRange filter).
  let dateRange: { start?: string; end?: string } | undefined =
    params.dateRange && typeof params.dateRange === "object" && !Array.isArray(params.dateRange)
      ? (params.dateRange as { start?: string; end?: string })
      : undefined;

  // Safety net: when the host signals urgency ("asap") with a specific day
  // restriction but the LLM didn't emit a concrete dateRange, constrain to
  // the next 14 days in host timezone. Prevents "find time with X next
  // Monday" from being interpreted as "all Mondays for the next 3 months."
  const restrictToDays = availability?.restrictToDays as string[] | undefined;
  if (!dateRange && urgency === "asap" && Array.isArray(restrictToDays) && restrictToDays.length > 0) {
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

  // activityOptions — ordered list of activities the host is open to
  // (e.g. ["hike", "coffee", "phone call"]). First entry mirrors `activity`
  // for backward compat. Stored in link.parameters.activityOptions (JSON blob —
  // no migration). Envoy presents these to the guest as a menu; picking
  // from the menu always passes the downgrade-ladder check.
  let activityOptionsOut: string[] | undefined;
  const rawActivityOptions = params.activityOptions;
  if (Array.isArray(rawActivityOptions) && rawActivityOptions.length > 1) {
    const cleaned = rawActivityOptions
      .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
      .map((o) => o.trim().slice(0, 60));
    if (cleaned.length > 1) activityOptionsOut = cleaned;
  }

  // Host-intent steering (proposal 2026-04-21): the LLM classifies the
  // host's phrasing into one of four tiers at create_link time. Accept
  // either top-level `params.intent: { steering }` or bare `params.steering`
  // (some older playbook revisions may emit it flat). Missing → default to
  // `open` per §4.9 / N6 — misclassification cost is asymmetric and the
  // safe fallback is the less-narrow tier.
  const intentParam = params.intent && typeof params.intent === "object" && !Array.isArray(params.intent)
    ? (params.intent as Record<string, unknown>).steering
    : undefined;
  const rawSteering = normalizeSteering(intentParam ?? params.steering);
  const declaredSteering: Steering = rawSteering ?? "open";

  // In-person location guard: if format is in-person, no location was set,
  // and guestPicks doesn't already declare location, mark it as guest-picks
  // so it's intentional rather than silently null. Generalized 2026-04-29
  // from the previous physical-activity-only guard — host can say
  // "in-person meeting with Larry — he picks the spot" without naming a
  // physical-activity token (bike ride / hike / coffee), and the deferral
  // still needs to flow through to the guest greeting's `guestPickHint`.
  // The previous guard required `isPhysicalActivity` (activity token
  // present) so this case silently dropped the deferral and Larry's
  // greeting was missing "Let me know where works for you."
  //
  // F7 fix (2026-05-01) — proposal `2026-04-30_composer-action-fidelity` §2
  // catalogue: when the composer emitted a NON-EMPTY `guestPicks` object
  // (any field signaled), it has thought about deferral and made an
  // explicit choice. Trust that choice — do NOT layer on a defensive
  // location auto-add behind the composer's back. The original target
  // case (composer fully omitted guestPicks on an in-person link) is
  // still caught: an empty/absent guestPicks means the composer never
  // engaged with deferral, and the guard's defensive write remains
  // valuable. Repro: bundle `cmon1vhs6...` link `rb9m9j` had composer-
  // emitted `guestPicks: { date: true }` for a recurring piano-lessons
  // anchor; handler auto-added `location: true` causing the UI deferral
  // line to read "location" while the composer's prose narrated date.
  const isInPerson = effectiveFormat === "in-person";
  if (isInPerson && !location) {
    const existingGuestPicks = params.guestPicks as Record<string, unknown> | undefined;
    const composerExpressedDeferral =
      existingGuestPicks != null &&
      typeof existingGuestPicks === "object" &&
      Object.keys(existingGuestPicks).length > 0;
    if (!existingGuestPicks?.location && !composerExpressedDeferral) {
      // Inject into the guestPicksOut that will be written to the link rules.
      guestPicksOut = { ...(guestPicksOut ?? {}), location: true };
      console.warn(
        `[create_link] in-person link${activity ? ` "${activity}"` : ""} had no location — setting guestPicks.location=true`,
      );
    } else if (composerExpressedDeferral && !existingGuestPicks?.location) {
      console.log(
        `[create_link] in-person link${activity ? ` "${activity}"` : ""} omitted location, but composer expressed other guestPicks (keys=${Object.keys(existingGuestPicks!).join(",")}); skipping defensive location auto-add (F7 fix)`,
      );
    }
  }

  const postureSnapshot = snapshotPostureFromUser({ preferences: userRow?.preferences as UserPreferences | null });
  const linkRulesPreIntent = normalizeLinkParameters({
    ...postureSnapshot,
    ...rules,
    ...(effectiveFormat ? { format: effectiveFormat } : {}),
    ...(effectiveDurationParam != null ? { duration: effectiveDurationParam } : {}),
    ...(urgency ? { urgency } : {}),
    ...(isVip ? { isVip: true } : {}),
    ...(availability ? { availability } : {}),
    ...(preferred ? { preferred } : {}),
    ...(dateRange ? { dateRange } : {}),
    ...(location ? { location } : {}),
    ...(activity ? { activity } : {}),
    ...(activityIcon ? { activityIcon } : {}),
    ...(timingLabel ? { timingLabel } : {}),
    ...(guestPicksOut ? { guestPicks: guestPicksOut } : {}),
    ...(guidanceOut ? { guestGuidance: guidanceOut } : {}),
    ...(activityOptionsOut ? { activityOptions: activityOptionsOut } : {}),
    ...(partialAttendance === "allowed"
      ? { partialAttendance, minimumAttendees }
      : {}),
  });

  // Asymmetric validator (§4.6): step DOWN when the LLM's intent
  // over-narrows the fields; never step UP. Trust intent when it
  // under-narrows — that's the motivating "anytime next two weeks" case
  // where `dateRange` is a bracket, not a narrowing.
  const validatedSteering = validateIntent(declaredSteering, linkRulesPreIntent, { linkCode: code });
  const linkRules = normalizeLinkParameters({
    ...linkRulesPreIntent,
    intent: { steering: validatedSteering },
  });
  // Silence unused-import warnings for constants referenced only in playbooks.
  void TIME_OF_DAY_WINDOWS;

  // Recurrence (2026-04-23): when the host frames the link as a series
  // ("weekly for 6 weeks with Sarah"), the LLM emits a `recurrence` object
  // shaped like LinkRecurrence. We validate here — malformed configs drop
  // to null (one-off link) rather than blocking creation; the drift is
  // surfaced via warn-log. See src/lib/recurrence.ts for the shape.
  let recurrenceForLink: LinkRecurrence | null = null;
  let recurrenceMultiGuestDropped = false;
  const rawRecurrence = params.recurrence;
  if (rawRecurrence != null) {
    try {
      recurrenceForLink = parseRecurrence(rawRecurrence);
    } catch (e) {
      console.warn(
        `[create_link] recurrence rejected (${(e as Error).message}) — raw: ${JSON.stringify(rawRecurrence).slice(0, 200)}`,
      );
    }
  }

  // §5.10b — defense-in-depth single-guest guard. Closes parent-proposal
  // §14.1 J8 drift that never landed in PR-A, per the
  // 2026-05-01_recurring-meeting-rendering-and-shareable-template R3 fold.
  // The composer playbook at calendar-event-composer.md:179 already says
  // "v1 scope — single-guest only" but composer drift could still emit a
  // multi-guest link with `recurrence` populated, leaving a malformed
  // series in the database. Drop recurrence at the handler boundary; the
  // first meeting still gets created.
  if (recurrenceForLink != null && inviteeNames.length > 1) {
    console.warn(
      `[create_link] recurrence dropped — v1 supports single-guest only (got inviteeNames.length=${inviteeNames.length})`,
    );
    recurrenceForLink = null;
    recurrenceMultiGuestDropped = true;
  }

  const link = await prisma.negotiationLink.create({
    data: {
      userId,
      type: "personalized",
      slug: meetSlug,
      code,
      inviteeName,
      inviteeNames,
      inviteeEmail,
      inviteeTimezone,
      topic,
      topicSource,
      hostNote,
      parameters: linkRules as Parameters<typeof prisma.negotiationLink.create>[0]["data"]["parameters"],
      ...(recurrenceForLink
        ? { recurrence: recurrenceForLink as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });

  const hostFirstName = resolveHostFirstName({ name: hostName });
  const { getInviteeDisplay, getWaitingLabel } = await import("@/lib/invitee-display");
  const inviteeDisplay = getInviteeDisplay({ inviteeNames, inviteeName });
  // topic is already null if it was generic (stripped at line 786 above).
  // Capitalize the meaningful activity phrase if present.
  const activityLabel = topic
    ? topic.charAt(0).toUpperCase() + topic.slice(1)
    : null;

  // Format-derived prefix when no meaningful activity.
  const effectiveFormatStr = typeof effectiveFormat === "string" ? effectiveFormat : null;
  const formatPrefix =
    effectiveFormatStr === "phone" ? "Call"
    : effectiveFormatStr === "video" ? "VC"
    : null;

  const prefix = activityLabel ?? formatPrefix;
  const isGroup = Array.isArray(inviteeNames) && inviteeNames.length > 1;
  const { getInviteeFirstNamesDisplay } = await import("@/lib/invitee-display");
  const firstNamesDisplay = getInviteeFirstNamesDisplay({ inviteeNames, inviteeName });

  const title =
    isGroup
      ? prefix
        ? `${prefix} (${firstNamesDisplay})`
        : firstNamesDisplay || "Meeting"
      : !inviteeDisplay
      ? (prefix ?? "Meeting")
      : prefix
      ? `${prefix}: ${inviteeDisplay} + ${hostFirstName}`
      : `${inviteeDisplay} + ${hostFirstName}`;

  const session = await prisma.negotiationSession.create({
    data: {
      linkId: link.id,
      hostId: userId,
      type: "calendar",
      status: "active",
      title,
      statusLabel: getWaitingLabel({ inviteeNames, inviteeName }),
      format: effectiveFormat,
      duration: effectiveDurationParam ?? 30,
    },
  });

  // SessionInvitee rows — one per named invitee. Only the first gets the
  // link-level email (host typically only collects one contact in v1).
  if (inviteeNames.length > 0) {
    await prisma.sessionInvitee.createMany({
      data: inviteeNames.map((name, i) => ({
        linkId: link.id,
        sessionId: session.id,
        name,
        email: i === 0 ? inviteeEmail : null,
        role: "guest",
      })),
    });
  }

  const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
  const url = `${baseUrl}/meet/${meetSlug}/${code}`;

  const baseMessage = `Created link for ${inviteeDisplay || "invitee"}${topic ? ` (${topic})` : ""}`;
  return {
    success: true,
    message: recurrenceMultiGuestDropped
      ? `${baseMessage} — Recurring group series isn't in v1 yet; I can set up the first meeting now.`
      : baseMessage,
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
      const existingRules = (newExplicit.structuredRules as AvailabilityPreference[] | undefined) ?? [];
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
        const newRule: AvailabilityPreference = {
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
    silent: true,
  };
}

/**
 * Save host meeting settings (phone, video provider, zoom link, default
 * duration) to user.preferences. Used when the host supplies one of these
 * mid-negotiation (e.g., drops a phone number into chat for a phone call)
 * or via the dedicated profile tier dispatch.
 *
 * Writes land under `preferences.explicit.*` — the canonical home per
 * Proposal 3 (decided 2026-04-21 §2.5). `writeProfileField` also strips
 * any legacy top-level copy of the same key so readers never see drift.
 * Legacy rows still work because `readProfileField` falls back to the
 * top level when `explicit.*` is absent.
 */
async function handleUpdateMeetingSettings(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const phone = params.phone as string | undefined;
  const videoProvider = params.videoProvider as "google-meet" | "zoom" | undefined;
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
  let prefs: UserPreferences = (user?.preferences as UserPreferences | null) ?? {};
  // Capture pre-edit value so we can detect a real change for the
  // clear-on-edit invariant below. Reusable-link guest-picks proposal,
  // decided 2026-04-28.
  const prevDefaultDuration =
    prefs.defaultDuration ?? prefs.explicit?.defaultDuration ?? null;

  const changed: string[] = [];
  if (phone !== undefined) {
    prefs = writeProfileField(prefs, "phone", phone || undefined);
    changed.push(phone ? `phone: ${phone}` : "cleared phone");
  }
  if (videoProvider !== undefined) {
    prefs = writeProfileField(prefs, "videoProvider", videoProvider || "google-meet");
    changed.push(`video provider: ${videoProvider}`);
  }
  if (zoomLink !== undefined) {
    prefs = writeProfileField(prefs, "zoomLink", zoomLink || undefined);
    changed.push(zoomLink ? `zoom link saved` : "cleared zoom link");
  }
  if (defaultDuration !== undefined) {
    prefs = writeProfileField(prefs, "defaultDuration", defaultDuration || 30);
    changed.push(`default duration: ${defaultDuration} min`);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      preferences: prefs as unknown as Prisma.InputJsonValue,
    },
  });

  // Clear-on-edit invariant for primary-link defaults: when the host changes
  // `defaultDuration`, every active primary-link session that locked a guest-
  // proposed value resets so the host's new default wins. Mirrors the
  // personalized-link path in handleUpdateLinkRules and the Bookable Link path
  // in availability-rules/edit/route.ts. Only runs when the value actually
  // changed (not on no-op writes). Reusable-link guest-picks proposal,
  // decided 2026-04-28.
  if (defaultDuration !== undefined && (defaultDuration || 30) !== prevDefaultDuration) {
    await prisma.negotiationSession.updateMany({
      where: {
        link: { userId, type: "primary" },
        status: { in: ["active", "pending"] },
        negotiatedDuration: { not: null },
      },
      data: { negotiatedDuration: null },
    });
  }

  invalidateBehaviorSnapshot(userId);

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
  if (topic) {
    linkUpdate.topic = topic;
    // Explicit host override via save_guest_info → custom by definition. If
    // the LLM happens to set topic to an activity word here, treating it as
    // custom is still correct — the host meant for it to be the title.
    linkUpdate.topicSource = "custom";
  }

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
 *   - `availability`: AvailabilitySpec (per-link event availability layer).
 *     `expand` adds offerable slots beyond calendar (off-hours, weekends).
 *     `restrictToDays/Windows/Slots` narrows what's offerable.
 *     `blockedSlots` excludes specific instances. See `link-parameters.ts`.
 *   - `preferred`: PreferredSpec (decoration only — drives `slot.preferred`
 *     flag and greeting copy, never hides slots). `days/windows/slots`.
 *   - `dateRange`: { start?, end? } — YYYY-MM-DD host-local inclusive.
 *   - `lastResort`: day-name array — soft-filter (drop only if other days exist).
 *
 * Supports both upgrade and downgrade. Rules merge — an explicit
 * `isVip: false` will overwrite an existing `true`.
 */
async function handleExpandLink(
  params: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const rawCode = (params.code as string) || null;
  // Defang LLM-invented placeholder codes (e.g. "LAST_CREATED", "LATEST")
  // the same way SESSION_ID_PLACEHOLDERS is applied to sessionId. Observed
  // 2026-04-29 (feedback cmokpex8b): LLM emitted `code: "LAST_CREATED"` on
  // update_link → "Link not found". The placeholder list is shared because
  // the LLM uses the same hallucinated tokens across both id surfaces.
  const codeIsPlaceholder =
    typeof rawCode === "string" && SESSION_ID_PLACEHOLDERS.has(rawCode.toUpperCase());
  const code = codeIsPlaceholder ? null : rawCode;
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

  // Placeholder-code fallback: when the LLM emitted "LAST_CREATED" (or
  // similar), resolve to the host's most recently created non-archived
  // link. Mirrors the sessionId placeholder defense (resolveSessionId) and
  // avoids the exactly-one-recent-draft constraint below — the host's
  // intent here is unambiguous ("the one I just made"), even if multiple
  // drafts exist in the last 5 minutes.
  let inferredLinkId: string | null = null;
  if (codeIsPlaceholder && !sessionId) {
    const latestLink = await prisma.negotiationLink.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, code: true },
    });
    if (latestLink) {
      inferredLinkId = latestLink.id;
      console.log(
        `[expand_link] placeholder code "${rawCode}" → resolved to latest link ${latestLink.code} (id=${latestLink.id}) for user ${userId}`,
      );
    }
  }

  // Narrow defensive fallback (2026-04-21): when the LLM omits BOTH code and
  // sessionId but the host has exactly ONE draft link created in the last
  // 5 minutes, use that link. This is the Suzie case from feedback
  // cmo85p0yq00071 — "oops - please change that to be just an hour" emitted
  // 12 min after create, with no identifier at all. The defense against
  // "silently misroute to an unrelated link" (which motivated the original
  // strict reject) still holds in the general case; we only soften when
  // there's exactly ONE unambiguous recent draft.
  if (!inferredLinkId && !code && !sessionId) {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentDrafts = await prisma.negotiationLink.findMany({
      where: {
        userId,
        createdAt: { gte: fiveMinAgo },
        sessions: { every: { status: { in: ["active"] }, agreedTime: null } },
      },
      select: { id: true, code: true },
      orderBy: { createdAt: "desc" },
      take: 2, // we only need to know "is it exactly one?"
    });
    if (recentDrafts.length === 1) {
      inferredLinkId = recentDrafts[0].id;
      console.log(
        `[expand_link] no code or sessionId — exactly-one-recent-draft fallback resolved linkId=${inferredLinkId} (code=${recentDrafts[0].code}) for user ${userId}`,
      );
    } else {
      return {
        success: false,
        message: "expand_link requires either a `code` (link code) or `sessionId`",
      };
    }
  }

  // Resolve link by code (preferred) or via session.linkId.
  let link: {
    id: string;
    userId: string;
    parameters: unknown;
    inviteeName: string | null;
    code: string | null;
    topic: string | null;
    topicSource: string | null;
    recurrence: unknown;
  } | null = null;
  let resolvedSessionIdForLink: string | null = sessionId || null;

  // Exactly-one-recent-draft fallback — short-circuit resolution when the
  // caller supplied no identifier. Safe because we verified uniqueness above.
  if (inferredLinkId) {
    link = await prisma.negotiationLink.findUnique({
      where: { id: inferredLinkId },
      select: { id: true, userId: true, parameters: true, inviteeName: true, code: true, topic: true, topicSource: true, recurrence: true },
    });
    if (link) {
      const latest = await prisma.negotiationSession.findFirst({
        where: { linkId: link.id, archived: false },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latest) resolvedSessionIdForLink = latest.id;
    }
  } else if (code) {
    link = await prisma.negotiationLink.findFirst({
      where: { code, userId },
      select: { id: true, userId: true, parameters: true, inviteeName: true, code: true, topic: true, topicSource: true, recurrence: true },
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
            link: { select: { id: true, userId: true, parameters: true, inviteeName: true, code: true, topic: true, topicSource: true, recurrence: true } },
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
        link: { select: { id: true, userId: true, parameters: true, inviteeName: true, code: true, topic: true, topicSource: true, recurrence: true } },
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
  const existingRules = parseLinkParameters(link.parameters);
  const patch: Record<string, unknown> = {};
  if (typeof params.isVip === "boolean") patch.isVip = params.isVip;

  // Three-band shape (2026-05-01 — proposal:
  // event-availability-vs-preferred-vs-calendar-scoring).
  // `availability` and `preferred` are merged-replace: caller passes the full
  // shape (or omits to leave unchanged). To clear, pass `{}`.
  if (params.availability !== undefined) patch.availability = params.availability;
  if (params.preferred !== undefined) patch.preferred = params.preferred;

  // One-off blocked datetime ranges (2026-04-28 event-edit proposal §3.5).
  // Subtractive against the slot grid the same way calendar busy events
  // are. Validated structurally; LLM is responsible for resolving date
  // language (e.g. "Thursday") to ISO datetimes via the link's dateRange.
  if (params.blockedRanges !== undefined) {
    if (params.blockedRanges === null || (Array.isArray(params.blockedRanges) && params.blockedRanges.length === 0)) {
      patch.blockedRanges = []; // explicit clear
    } else {
      const result = validateBlockedRanges(params.blockedRanges);
      if (!result.ok) {
        return { success: false, message: `update_link rejected blockedRanges: ${result.reason}` };
      }
      patch.blockedRanges = result.ranges;
    }
  }
  if (params.lastResort !== undefined) patch.lastResort = params.lastResort;
  if (params.dateRange !== undefined) patch.dateRange = params.dateRange;

  // V4 link-rule fields (2026-04-20): timing label + format/duration +
  // activity/activityIcon/location. All free-form; sanitized via
  // normalizeLinkParameters where it applies (duration must be positive int).
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

  // guestPicks / guestGuidance — the host can change deferrals after link
  // creation ("actually let her choose the spot"). Accepted on `update_link`
  // per proposal 2026-04-29 §3.B (link-handler-consolidation). Today's
  // handler ignored these fields, which produced an empty-patch gate error
  // when the host tried to flip a deferral.
  //
  // Merge semantics — PER-SUB-KEY, not whole-object replace. Patching
  // `guestPicks: { location: true }` on a link with `guestPicks: { duration:
  // [60,90] }` produces `{ duration: [60,90], location: true }` — the
  // existing duration deferral is preserved. The handler resolves this
  // against `existingRules.guestPicks` below in the merge step; here we
  // just pass through the patch fragment.
  if (params.guestPicks !== undefined && typeof params.guestPicks === "object" && params.guestPicks !== null && !Array.isArray(params.guestPicks)) {
    const incoming = params.guestPicks as Record<string, unknown>;
    const existingGuestPicks = (existingRules as Record<string, unknown>).guestPicks as Record<string, unknown> | undefined;
    patch.guestPicks = { ...(existingGuestPicks ?? {}), ...incoming };
  }
  if (params.guestGuidance !== undefined && typeof params.guestGuidance === "object" && params.guestGuidance !== null && !Array.isArray(params.guestGuidance)) {
    const incoming = params.guestGuidance as Record<string, unknown>;
    const existingGuestGuidance = (existingRules as Record<string, unknown>).guestGuidance as Record<string, unknown> | undefined;
    // Top-level merge; nested `suggestions` object replaces wholesale (rare
    // edit pattern; if needed, the LLM emits the full `suggestions` block).
    patch.guestGuidance = { ...(existingGuestGuidance ?? {}), ...incoming };
  }

  // Invitee-set swap — a multi-invitee edit ("actually change it to Will and
  // Mingst") is an update, not a new link. Without this branch the LLM has
  // no way to swap invitees via update_link and reaches for create_link —
  // which loses duration and other link-level fields (see 2026-04-23 bug).
  // Column write happens outside the rules-JSON patch since inviteeName /
  // inviteeNames live directly on NegotiationLink.
  let inviteeNamesPatch: string[] | undefined;
  if (Array.isArray(params.inviteeNames)) {
    inviteeNamesPatch = (params.inviteeNames as unknown[])
      .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
      .map((n) => n.trim().slice(0, 80));
  } else if (typeof params.inviteeName === "string") {
    const n = params.inviteeName.trim().slice(0, 80);
    if (n) inviteeNamesPatch = [n];
  }

  // Host-intent steering (proposal 2026-04-21). Accept nested `intent` or
  // bare `steering`; invalid values are silently dropped (§4.6 validator
  // runs downstream regardless). Ignored from the "needs at least one
  // field to change" gate — a bare steering update without any other edit
  // is almost certainly a mistake; if the LLM wants to reclassify without
  // changing rule fields, it's doing something that the split rule §4.7
  // handles via the direct-UI path instead.
  if (params.intent && typeof params.intent === "object" && !Array.isArray(params.intent)) {
    const s = normalizeSteering((params.intent as Record<string, unknown>).steering);
    if (s) patch.intent = { steering: s };
  } else if (typeof params.steering === "string") {
    const s = normalizeSteering(params.steering);
    if (s) patch.steering = s;
  }

  // Guard: only `intent`/`steering` alone doesn't count as a meaningful
  // update — every other field does. Recurrence is handled below as a
  // non-parameters-merge write (it lands on `link.recurrence`, not
  // `link.parameters`), so the gate also counts a recurrence-only emit
  // as a meaningful update — per proposal §3.3 (2026-05-03), this is
  // the load-bearing fix that makes "change to biweekly" work.
  const patchKeysForGate = Object.keys(patch).filter(
    (k) => k !== "intent" && k !== "steering",
  );
  const hasRecurrencePatch = "recurrence" in params;
  if (patchKeysForGate.length === 0 && inviteeNamesPatch === undefined && !hasRecurrencePatch) {
    return {
      success: false,
      message: "update_link needs at least one field to change (isVip, availability, preferred, lastResort, dateRange, blockedRanges, timingLabel, format, duration, activity, activityIcon, location, inviteeNames, guestPicks, guestGuidance, recurrence)",
    };
  }

  const mergedRulesPreIntent = normalizeLinkParameters({ ...existingRules, ...patch });

  // §4.7 split rule — this handler is only reached from the agent action
  // path (LLM emitted `[ACTION]{update_link}`), so by definition the edit
  // is LLM-driven: always reclassify. Three sources for the new steering,
  // in priority order:
  //   1. LLM supplied it explicitly in params (`{intent:{steering}}` or
  //      bare `steering`) — trust but validate.
  //   2. Prior intent is present AND the edit isn't a material narrowing
  //      shift — keep prior (§4.7 "LLM-driven always reclassify" is the
  //      default; but if the playbook didn't emit a new steering AND the
  //      shape didn't shift materially, the prior is still authoritative).
  //   3. Fall back to `deriveLegacy` of the merged rules.
  // Every path runs through `validateIntent` so the asymmetric step-down
  // applies uniformly — a wide-dateRange narrow stays `soft`, an exclusive
  // without a score-(-2) override steps down to `narrow`, etc.
  const patchIntent = (patch as Record<string, unknown>).intent;
  const patchSteeringRaw =
    patchIntent && typeof patchIntent === "object" && !Array.isArray(patchIntent)
      ? (patchIntent as Record<string, unknown>).steering
      : (patch as Record<string, unknown>).steering;
  const patchSteering = normalizeSteering(patchSteeringRaw);
  const priorSteering = readStoredSteering(existingRules);
  const material = hasMaterialNarrowingChange(existingRules, mergedRulesPreIntent);

  let nextSteering: Steering;
  if (patchSteering) {
    nextSteering = validateIntent(patchSteering, mergedRulesPreIntent, { linkCode: link.code });
  } else if (priorSteering && !material) {
    nextSteering = validateIntent(priorSteering, mergedRulesPreIntent, { linkCode: link.code });
  } else {
    nextSteering = validateIntent(deriveLegacy(mergedRulesPreIntent), mergedRulesPreIntent, { linkCode: link.code });
  }

  const mergedRules = normalizeLinkParameters({
    ...mergedRulesPreIntent,
    intent: { steering: nextSteering },
  });

  // Topic-clearing on activity change (proposal §3.B.1, decided 2026-04-28).
  // Provenance-driven, NOT text-matching. The topicSource column is the
  // deterministic answer to "did the title include something that just
  // changed?":
  //   "activity" → topic was activity-derived; clear it so getEventTitle()
  //                falls through to format/name templates with the new
  //                activity surfacing via parameters.activity / activityIcon.
  //   "custom"   → host-set phrase like "Q3 review"; preserve.
  //   null       → no topic was ever set; nothing to do.
  // Defense-in-depth: if topicSource is null but link.topic is set (legacy
  // row missed by the migration backfill), fall back to findActivity() text
  // match so the row gets cleaned up on first edit.
  let topicClearUpdate: { topic: null; topicSource: null } | null = null;
  if (patch.activity !== undefined && link.topic) {
    const provenance = link.topicSource ?? (findActivity(link.topic) ? "activity" : "custom");
    if (provenance === "activity") {
      topicClearUpdate = { topic: null, topicSource: null };
    }
  }

  // Recurrence patch (proposal `2026-05-03_recurring-and-office-hours-widgets`
  // §3.3 — closes the Rule 21(c) drift latent since the parent recurring-
  // meeting proposal's PR-A shipped 2026-04-23). The composer playbook at
  // `calendar-event-composer.md:178` says series-level edits go through
  // `update_link` with a `recurrence` param; until this lands the handler
  // silently ignored that emit. Now: validate the patch via the canonical
  // `parseRecurrence`, persist on `link.recurrence`, track as a material edit.
  //
  // Edge cases handled:
  //   - host explicitly clears recurrence by emitting `recurrence: null` →
  //     write null (link reverts to one-off; greeting falls back).
  //   - patch validates: full shape replaces existing (host-driven authoritative
  //     edit; partial-merge would conflict with the pre-anchor / post-anchor
  //     state machine).
  //   - patch malformed: clean error returned; existing recurrence preserved.
  //   - host omitted recurrence: noop (existing recurrence preserved).
  let recurrencePatchWrite:
    | { recurrence: Prisma.InputJsonValue | typeof Prisma.JsonNull }
    | null = null;
  let recurrencePatchEdited = false;
  if ("recurrence" in params) {
    const rawRec = params.recurrence;
    if (rawRec === null) {
      // Host explicitly cleared recurrence — write Prisma.JsonNull (the SQL
      // NULL sentinel for nullable Json columns) rather than `null` directly.
      recurrencePatchWrite = { recurrence: Prisma.JsonNull };
      recurrencePatchEdited = true;
    } else if (rawRec !== undefined) {
      try {
        const parsed = parseRecurrence(rawRec);
        recurrencePatchWrite = { recurrence: parsed as unknown as Prisma.InputJsonValue };
        // Compare against existing to avoid spurious edit-tracking.
        const priorRec = readRecurrence(link.recurrence as Prisma.JsonValue);
        const changed = JSON.stringify(priorRec) !== JSON.stringify(parsed);
        if (changed) recurrencePatchEdited = true;
      } catch (e) {
        return {
          success: false,
          message: `update_link: invalid recurrence — ${(e as Error).message}`,
        };
      }
    }
  }

  // Material-edit tracking (proposal §3.C, decided 2026-04-28). Diff the
  // pre/post rules — plus the inviteeNames column write, plus the topic
  // clear-on-activity-change path — to compute which canonical material
  // fields changed in this update. Powers the "Edited just now — activity,
  // hours" pill via material-fields.ts humanizer.
  const materialDiffPriorRules = existingRules as unknown as Record<string, unknown>;
  const materialDiffNextRules = mergedRules as unknown as Record<string, unknown>;
  const editedFields = diffMaterialFields(materialDiffPriorRules, materialDiffNextRules);
  if (inviteeNamesPatch !== undefined) {
    // inviteeNames lives on the link column, not in parameters; the diff
    // function above only sees parameters fields. Add manually if changed.
    const priorInvitees = link.inviteeName ? [link.inviteeName] : [];
    if (JSON.stringify(priorInvitees) !== JSON.stringify(inviteeNamesPatch)) {
      if (!editedFields.includes("inviteeNames")) editedFields.push("inviteeNames");
    }
  }
  if (topicClearUpdate) {
    if (!editedFields.includes("topic")) editedFields.push("topic");
  }
  if (recurrencePatchEdited) {
    if (!editedFields.includes("recurrence")) editedFields.push("recurrence");
  }
  const materialEditWrite =
    editedFields.length > 0
      ? { lastMaterialEditAt: new Date(), lastEditedFields: editedFields }
      : {};

  await prisma.negotiationLink.update({
    where: { id: link.id },
    data: {
      parameters: mergedRules as Parameters<typeof prisma.negotiationLink.update>[0]["data"]["parameters"],
      ...(inviteeNamesPatch !== undefined
        ? {
            inviteeNames: inviteeNamesPatch,
            inviteeName: inviteeNamesPatch[0] ?? null,
          }
        : {}),
      ...(topicClearUpdate ?? {}),
      ...(recurrencePatchWrite ?? {}),
      ...materialEditWrite,
    },
  });

  // Invitee-set swap: rebuild SessionInvitee rows on every active session
  // for this link, and refresh session titles so the dashboard card reflects
  // the new roster. Delete-then-recreate is safe here — SessionInvitee is an
  // index of who was invited; per-slot RSVPs hang off it but for the
  // draft/active phase (where this edit path applies) there's no RSVP data
  // worth preserving yet.
  if (inviteeNamesPatch !== undefined) {
    const activeSessionsForInvitees = await prisma.negotiationSession.findMany({
      where: { linkId: link.id, status: { in: ["active", "pending"] } },
      select: { id: true, format: true },
    });
    const { getInviteeDisplay, getInviteeFirstNamesDisplay } = await import("@/lib/invitee-display");
    const hostUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const hostFirstName = resolveHostFirstName(hostUser);
    const activityRaw = (mergedRules as Record<string, unknown>).activity;
    const activityLabel = typeof activityRaw === "string" && activityRaw.trim()
      ? activityRaw.charAt(0).toUpperCase() + activityRaw.slice(1)
      : null;
    const isGroupNow = inviteeNamesPatch.length > 1;
    const inviteeNameSingular = inviteeNamesPatch[0] ?? null;
    const inviteeDisplay = getInviteeDisplay({
      inviteeNames: inviteeNamesPatch,
      inviteeName: inviteeNameSingular,
    });
    const firstNamesDisplay = getInviteeFirstNamesDisplay({
      inviteeNames: inviteeNamesPatch,
      inviteeName: inviteeNameSingular,
    });

    const activityForTitle = typeof activityRaw === "string" ? activityRaw : null;
    void activityLabel; // kept for back-compat with surrounding scope; computeSessionTitle handles it

    for (const s of activeSessionsForInvitees) {
      await prisma.sessionInvitee.deleteMany({ where: { sessionId: s.id } });
      if (inviteeNamesPatch.length > 0) {
        await prisma.sessionInvitee.createMany({
          data: inviteeNamesPatch.map((name, i) => ({
            linkId: link.id,
            sessionId: s.id,
            name,
            email: i === 0 ? null : null,
            role: "guest",
          })),
        });
      }
      const nextTitle = computeSessionTitle({
        activity: activityForTitle,
        format: typeof s.format === "string" ? s.format : null,
        inviteeDisplay,
        firstNamesDisplay,
        isGroup: isGroupNow,
        hostFirstName,
      });
      await prisma.negotiationSession.update({
        where: { id: s.id },
        data: { title: nextTitle },
      });
    }
  } else if (patch.activity !== undefined) {
    // Activity-only refresh path (proposal §3.B.1, decided 2026-04-28).
    // No invitee swap, but the activity changed — session titles need to
    // pick up the new activity. Reuse computeSessionTitle with each
    // session's existing invitee set rather than rebuilding SessionInvitee.
    const activeSessions = await prisma.negotiationSession.findMany({
      where: { linkId: link.id, status: { in: ["active", "pending"] } },
      select: {
        id: true,
        format: true,
        invitees: { select: { name: true }, orderBy: { id: "asc" } },
      },
    });
    if (activeSessions.length > 0) {
      const { getInviteeDisplay, getInviteeFirstNamesDisplay } = await import("@/lib/invitee-display");
      const hostUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const hostFirstName = resolveHostFirstName(hostUser);
      const activityForTitle = typeof (mergedRules as Record<string, unknown>).activity === "string"
        ? ((mergedRules as Record<string, unknown>).activity as string)
        : null;
      for (const s of activeSessions) {
        const inviteeNames = s.invitees.map((i) => i.name).filter((n): n is string => !!n);
        // Fall back to the link's inviteeName column if SessionInvitee rows
        // are empty (legacy single-guest sessions seeded before group code).
        const fallbackInvitees = inviteeNames.length === 0 && link.inviteeName
          ? [link.inviteeName]
          : inviteeNames;
        const inviteeNameSingular = fallbackInvitees[0] ?? null;
        const inviteeDisplay = getInviteeDisplay({
          inviteeNames: fallbackInvitees,
          inviteeName: inviteeNameSingular,
        });
        const firstNamesDisplay = getInviteeFirstNamesDisplay({
          inviteeNames: fallbackInvitees,
          inviteeName: inviteeNameSingular,
        });
        const isGroup = fallbackInvitees.length > 1;
        const nextTitle = computeSessionTitle({
          activity: activityForTitle,
          format: typeof s.format === "string" ? s.format : null,
          inviteeDisplay,
          firstNamesDisplay,
          isGroup,
          hostFirstName,
        });
        await prisma.negotiationSession.update({
          where: { id: s.id },
          data: { title: nextTitle },
        });
      }
    }
  }

  // Clear guest-negotiated values on active sessions when the host edits
  // location or activity (host edit is authoritative — R2/option-a from
  // proposal 2026-04-22_guest-activity-location-negotiation). Session-only
  // write so there's no dual-write trust issue; confirm route reads
  // negotiatedLocation ?? link.parameters.location, so the host's new value
  // now wins.
  const negotiatedClearData: Record<string, null> = {};
  if (patch.location !== undefined) {
    negotiatedClearData.negotiatedLocation = null;
    negotiatedClearData.negotiatedFormat = null;
  }
  if (patch.activity !== undefined) {
    negotiatedClearData.negotiatedActivity = null;
    negotiatedClearData.negotiatedFormat = null;
  }
  // Reusable-link guest-picks proposal, decided 2026-04-28: extend the
  // host-edit-clears-guest-lock invariant to duration. When the host edits
  // link duration, any active session that locked a guest-proposed value
  // resets so the host's new value wins at confirm time.
  if (patch.duration !== undefined) {
    negotiatedClearData.negotiatedDuration = null;
  }
  if (patch.format !== undefined) {
    negotiatedClearData.negotiatedFormat = null;
  }
  if (Object.keys(negotiatedClearData).length > 0) {
    await prisma.negotiationSession.updateMany({
      where: { linkId: link.id, status: { in: ["active", "pending"] } },
      data: negotiatedClearData as Parameters<typeof prisma.negotiationSession.updateMany>[0]["data"],
    });
  }
  // Propagate the host's new duration to the denormalized NegotiationSession.duration
  // column so the thread card in the dashboard feed reflects the change immediately.
  // NegotiationSession.duration is a snapshot set at session creation; it doesn't
  // auto-update when link.parameters.duration changes — this write keeps them in sync.
  // Must be a separate updateMany (not folded into negotiatedClearData above) because
  // negotiatedClearData is null-only; duration is a non-null Int.
  if (patch.duration !== undefined) {
    await prisma.negotiationSession.updateMany({
      where: { linkId: link.id, status: { in: ["active", "pending"] } },
      data: { duration: patch.duration as number },
    });
  }
  // Same propagation for format — NegotiationSession.format is a snapshot set
  // at session creation; without this write the dashboard thread card keeps
  // showing the stale format ("Video · 2h" when the host just changed it to
  // in-person). Live-fix from 2026-04-29 testing — Bug 1 in the post-deploy
  // feedback batch.
  if (patch.format !== undefined && typeof patch.format === "string") {
    await prisma.negotiationSession.updateMany({
      where: { linkId: link.id, status: { in: ["active", "pending"] } },
      data: { format: patch.format as string },
    });
  }

  // Human-readable confirmation message.
  const changedParts: string[] = [];
  if (patch.isVip !== undefined) {
    changedParts.push(`VIP: ${patch.isVip ? "on" : "off"}`);
  }
  if (patch.availability !== undefined) {
    changedParts.push("availability updated");
  }
  if (patch.preferred !== undefined) {
    changedParts.push("preferences updated");
  }
  if (patch.dateRange !== undefined) {
    changedParts.push(`dateRange: updated`);
  }
  if (patch.timingLabel !== undefined) changedParts.push(`timing: ${patch.timingLabel ?? "cleared"}`);
  if (patch.format !== undefined) changedParts.push(`format: ${patch.format}`);
  if (patch.duration !== undefined) changedParts.push(`duration: ${formatDuration(patch.duration as number)}`);
  if (patch.activity !== undefined) changedParts.push(`activity: ${patch.activity ?? "cleared"}`);
  if (patch.location !== undefined) changedParts.push(`location: ${patch.location ?? "cleared"}`);
  if (inviteeNamesPatch !== undefined) {
    changedParts.push(`invitees: ${inviteeNamesPatch.join(", ") || "cleared"}`);
  }
  // Deferral changes (F.3 in proposal 2026-04-29). Summarize which sub-keys
  // flipped — "guestPicks: location-deferred" / "duration-deferred" — rather
  // than dumping the JSON, so the host sees a readable confirmation.
  if (patch.guestPicks !== undefined && typeof patch.guestPicks === "object" && patch.guestPicks !== null) {
    const gp = patch.guestPicks as Record<string, unknown>;
    const deferred: string[] = [];
    if (gp.location === true) deferred.push("location-deferred");
    if (gp.date === true) deferred.push("date-deferred");
    if (gp.format === true || Array.isArray(gp.format)) deferred.push("format-deferred");
    if (gp.duration === true || Array.isArray(gp.duration)) deferred.push("duration-deferred");
    if (deferred.length > 0) changedParts.push(`guestPicks: ${deferred.join(", ")}`);
  }
  if (patch.guestGuidance !== undefined) {
    changedParts.push(`guidance: updated`);
  }

  // Post-edit follow-up: drop a short administrator message into every
  // active session on this link so the guest's deal-room shows what
  // changed since they last looked. Intentionally an additive message
  // (not a greeting rewrite) — honors the chat-history model: what was
  // offered before still appears above, the update is news.
  //
  // HOWEVER: only post the update-proposal to sessions that already have
  // a greeting (≥1 administrator message). For pre-engagement sessions
  // (host created + edited the link before the guest ever visited), there
  // is no greeting to "add to" yet — posting a bare "John updated the
  // proposal…" as the guest's very first impression is confusing and makes
  // them think something was replaced. Skip those; the first-visit
  // greeting path in session/route.ts will compute a fresh greeting
  // reflecting the latest link.parameters, so the update is already baked into
  // what they see. Fixes 2026-04-21 bug where Ginger's guest view showed
  // only "John updated the proposal — duration now 2h" and no greeting.
  try {
    const activeSessions = await prisma.negotiationSession.findMany({
      where: {
        linkId: link.id,
        status: { in: ["active", "pending"] },
        messages: { some: { role: "administrator" } },
      },
      select: { id: true },
    });
    if (activeSessions.length > 0) {
      // hostFirstName previously prefixed the bubble follow-up ("John updated
      // the proposal — …"). Removed when the follow-up switched to inline
      // role:"system" messages that match the existing per-field ✓ style
      // (commit ee4842d). Guest-name-aware deferral copy reads link.invitee
      // Name directly. If we ever bring back a host-name prefix, restore the
      // findUnique call here.
      // Diff against existingRules — only mention fields whose VALUE actually
      // changed. Composers sometimes re-assert unchanged fields when packing
      // multiple edits into one update_link (e.g., re-emitting activity +
      // duration alongside a time-window widening). Without this guard the
      // follow-up reads "format now in-person; duration now 2h; activity now
      // 'bike ride'; time window updated" even though only the time window
      // actually moved — confusing for the guest. Live-fix from 2026-04-29
      // testing — Bug 2a in the post-deploy feedback batch.
      const existing = existingRules as Record<string, unknown>;
      const changedAndDifferent = (field: string): boolean => {
        if (patch[field] === undefined) return false;
        const a = existing[field];
        const b = patch[field];
        try {
          return JSON.stringify(a) !== JSON.stringify(b);
        } catch {
          return a !== b;
        }
      };
      const followupParts: string[] = [];
      if (changedAndDifferent("availability")) {
        followupParts.push("availability updated");
      }
      if (changedAndDifferent("preferred")) {
        followupParts.push("preferences updated");
      }
      if (changedAndDifferent("dateRange")) followupParts.push("date range updated");
      if (changedAndDifferent("timingLabel") && patch.timingLabel) {
        followupParts.push(`timing now "${patch.timingLabel}"`);
      }
      if (changedAndDifferent("format")) followupParts.push(`format now ${patch.format}`);
      if (changedAndDifferent("duration")) followupParts.push(`duration now ${formatDuration(patch.duration as number)}`);
      if (changedAndDifferent("activity") && patch.activity) followupParts.push(`activity now "${patch.activity}"`);
      if (changedAndDifferent("location") && patch.location) followupParts.push(`location now ${patch.location}`);
      if (changedAndDifferent("blockedRanges")) {
        followupParts.push("blocked time updated");
      }
      // Deferral changes (F.2 in proposal 2026-04-29). Active-session
      // greetings are deliberately NOT recomputed (B5 precedent — see F.1);
      // this follow-up message is how the guest learns about a post-create
      // deferral flip. Render with guest-name-aware copy when we have one.
      // Deferral copy is guest-facing, second-person, and combined into a
      // single invitation rather than one ✓ per sub-key. Per John's 2026-
      // 04-29 feedback: "instead of 'John updated the proposal — deferrals
      // updated' lets keep it succinct and clear. 'Update: Feel free to
      // suggest time/location'. or something even clearer than that."
      // Result: "Feel free to suggest a {list}" where list is comma-joined
      // noun phrases. Drops the "Update:" prefix since the inline ✓ style
      // already signals it's a system update.
      if (changedAndDifferent("guestPicks") && patch.guestPicks && typeof patch.guestPicks === "object") {
        const gp = patch.guestPicks as Record<string, unknown>;
        const newlyDeferred: string[] = [];
        if (gp.location === true) newlyDeferred.push("location");
        if (gp.duration === true || Array.isArray(gp.duration)) newlyDeferred.push("length");
        if (gp.date === true) newlyDeferred.push("day");
        if (gp.format === true || Array.isArray(gp.format)) newlyDeferred.push("format");
        if (newlyDeferred.length > 0) {
          // Comma-join with Oxford "or" before the last item.
          //   1 → "a location"
          //   2 → "a length or location"
          //   3 → "a day, length, or location"
          let joined: string;
          if (newlyDeferred.length === 1) {
            joined = `a ${newlyDeferred[0]}`;
          } else if (newlyDeferred.length === 2) {
            joined = `a ${newlyDeferred[0]} or ${newlyDeferred[1]}`;
          } else {
            joined = `a ${newlyDeferred.slice(0, -1).join(", ")}, or ${newlyDeferred[newlyDeferred.length - 1]}`;
          }
          followupParts.push(`feel free to suggest ${joined}`);
        }
      }
      if (changedAndDifferent("guestGuidance")) {
        followupParts.push("guidance updated");
      }
      // Render each followup as its own role:"system" message with
      // metadata.kind:"host_update" so the deal-room renders them as inline
      // ✓ system-style lines (matches the existing update_format pattern at
      // actions.ts:631 and the dashboard ✓ summary). No more "John updated
      // the proposal — …. Let me know if this changes anything on your side"
      // bubble — that pattern collided visually with the existing per-field
      // ✓ messages and produced redundant noise. Live-fix from 2026-04-29
      // testing — feedback batch following PR commit 083db9f.
      if (followupParts.length > 0) {
        const messages = followupParts.map((part) => {
          // Capitalize first letter for display ("Hannah can pick…" / "Time
          // window updated"), but preserve guest-name-aware lines as-is.
          const content = part.charAt(0).toUpperCase() + part.slice(1);
          return content;
        });
        await Promise.all(
          activeSessions.flatMap((s) =>
            messages.map((content) =>
              prisma.message.create({
                data: {
                  sessionId: s.id,
                  role: "system",
                  content,
                  metadata: { kind: "host_update", field: "link_rules" } as Prisma.InputJsonValue,
                },
              })
            ),
          ),
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
    data: { linkId: link.id, code: link.code, parameters: mergedRules, sessionId: resolvedSessionIdForLink ?? undefined },
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

// ---------------------------------------------------------------------------
// Profile / rule handlers — Proposal 3 (Progressive Profiling), decided
// 2026-04-21. Called from the narrower profile + rule dispatch tiers.
// Both land writes under `preferences.explicit.*` (canonical per §2.5).
// ---------------------------------------------------------------------------

const ALLOWED_BUFFERS = new Set([0, 5, 10, 15, 30]);

/**
 * Update business hours window + between-meeting buffer. Writes to
 * `preferences.explicit.businessHoursStart`, `businessHoursEnd`, and
 * `bufferMinutes`. Any field can be omitted. Triggers `invalidateSchedule`
 * on any change — recomputed with fresh inputs on the next query.
 */
async function handleUpdateBusinessHours(
  params: Record<string, unknown>,
  userId: string,
): Promise<ActionResult> {
  const startRaw = params.start;
  const endRaw = params.end;
  const bufferRaw = params.buffer;

  const start = typeof startRaw === "number" ? startRaw : undefined;
  const end = typeof endRaw === "number" ? endRaw : undefined;
  const buffer = typeof bufferRaw === "number" ? bufferRaw : undefined;

  if (start === undefined && end === undefined && buffer === undefined) {
    return { success: false, message: "No business-hours fields to update" };
  }

  if (start !== undefined && (start < 0 || start > 23 || !Number.isInteger(start))) {
    return { success: false, message: `Invalid start hour: ${start} (must be integer 0-23)` };
  }
  if (end !== undefined && (end < 1 || end > 24 || !Number.isInteger(end))) {
    return { success: false, message: `Invalid end hour: ${end} (must be integer 1-24)` };
  }
  if (buffer !== undefined && !ALLOWED_BUFFERS.has(buffer)) {
    return { success: false, message: `Invalid buffer: ${buffer} (must be one of 0, 5, 10, 15, 30)` };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const prefs: UserPreferences = (user?.preferences as UserPreferences | null) ?? {};
  const explicit = { ...(prefs.explicit ?? {}) };

  const effectiveStart = start ?? explicit.businessHoursStart ?? 9;
  const effectiveEnd = end ?? explicit.businessHoursEnd ?? 18;
  if (effectiveStart >= effectiveEnd) {
    return {
      success: false,
      message: `Business hours end (${effectiveEnd}) must be after start (${effectiveStart})`,
    };
  }

  const changed: string[] = [];
  if (start !== undefined) {
    explicit.businessHoursStart = start;
    changed.push(`start ${start}`);
  }
  if (end !== undefined) {
    explicit.businessHoursEnd = end;
    changed.push(`end ${end}`);
  }
  if (buffer !== undefined) {
    explicit.bufferMinutes = buffer;
    changed.push(`buffer ${buffer}m`);
  }

  const nextPrefs: UserPreferences = { ...prefs, explicit };

  await prisma.user.update({
    where: { id: userId },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });

  // V1.5: fan-out changed posture fields to all variance links so they stay
  // in sync when the host edits business hours globally. scope "all" re-writes
  // User.preferences with the same values (idempotent, harmless double-write)
  // AND writes to every variance link. Fan-out failure is non-fatal — Primary
  // was already written; log and continue so the agent response isn't blocked.
  const postureUpdate: Record<string, unknown> = {};
  if (start !== undefined) postureUpdate.hoursStartMinutes = start * 60;
  if (end !== undefined) postureUpdate.hoursEndMinutes = end * 60;
  if (buffer !== undefined) postureUpdate.bufferMinutes = buffer;

  if (Object.keys(postureUpdate).length > 0) {
    const { applyPostureToScope } = await import("@/lib/links/scope");
    await applyPostureToScope(
      postureUpdate as import("@/lib/links/scope").PostureUpdate,
      "all",
      userId
    ).catch((err) => {
      console.error("[handleUpdateBusinessHours] variance fan-out failed", err);
    });
  }

  const { invalidateSchedule } = await import("@/lib/calendar");
  await invalidateSchedule(userId);
  invalidateBehaviorSnapshot(userId);

  return {
    success: true,
    message: `Business hours updated (${changed.join(", ")})`,
  };
}

/**
 * Add, update, or remove a structured availability rule. Rules live at
 * `preferences.explicit.structuredRules` — see src/lib/availability-rules.ts
 * for the AvailabilityPreference shape and compileStructuredRules pathway.
 *
 * This handler does not recompile rules itself — that happens on the next
 * availability query via the normal scoring path. It does call
 * `invalidateSchedule` so stale compiled output is discarded.
 */
/**
 * Build the public shareable URL for a bookable link.
 * Format: https://agentenvoy.ai/meet/{slug}/{code} — matches the deal-room link pattern.
 * Host kept consistent with elsewhere; caller can swap origin for staging.
 */
function buildBookableLinkUrl(slug: string, code: string): string {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || "https://agentenvoy.ai";
  return `${origin}/meet/${slug}/${code}`;
}

/**
 * Collect normalized bookable-link names for a host — all active bookable
 * rules plus the primaryLinkName (defaulting to "Primary link"). Used for the
 * per-host uniqueness guard. Optional `exceptRuleId` excludes one rule from
 * the check (so renaming a rule doesn't collide with its own prior name).
 */
function normalizeNameForGuard(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function collectNormalizedLinkNames(
  existing: AvailabilityPreference[],
  primaryLinkName: string | undefined,
  opts: { exceptRuleId?: string; includeGeneral?: boolean } = {},
): Set<string> {
  const { exceptRuleId, includeGeneral = true } = opts;
  const out = new Set<string>();
  for (const r of existing) {
    if (r.action !== "bookable") continue;
    const bookableData = r.bookable;
    if (!bookableData) continue;
    if (exceptRuleId && r.id === exceptRuleId) continue;
    const name = (bookableData.name ?? bookableData.title ?? "").trim();
    if (name) out.add(normalizeNameForGuard(name));
  }
  if (includeGeneral) {
    out.add(
      normalizeNameForGuard(
        primaryLinkName && primaryLinkName.trim() ? primaryLinkName : "Primary link",
      ),
    );
  }
  return out;
}

async function handleUpdateAvailabilityRule(
  params: Record<string, unknown>,
  userId: string,
): Promise<ActionResult> {
  const operation = params.operation as
    | "add"
    | "update"
    | "remove"
    | "rename_primary"
    | undefined;
  const id = typeof params.id === "string" ? params.id : undefined;
  const ruleInput = params.rule as Partial<AvailabilityPreference> | undefined;

  if (
    operation !== "add" &&
    operation !== "update" &&
    operation !== "remove" &&
    operation !== "rename_primary"
  ) {
    return { success: false, message: `Invalid operation: ${String(operation)}` };
  }
  if ((operation === "update" || operation === "remove") && !id) {
    return { success: false, message: `Operation "${operation}" requires an id` };
  }
  if ((operation === "add" || operation === "update") && !ruleInput) {
    return { success: false, message: `Operation "${operation}" requires a rule body` };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true, meetSlug: true },
  });
  const prefs: UserPreferences = (user?.preferences as UserPreferences | null) ?? {};
  const explicit = { ...(prefs.explicit ?? {}) };
  const existing =
    ((explicit as Record<string, unknown>).structuredRules as AvailabilityPreference[] | undefined) ?? [];
  const currentGeneralName =
    typeof explicit.primaryLinkName === "string" ? explicit.primaryLinkName : undefined;

  let nextRules: AvailabilityPreference[] = existing;
  let summary: string;
  let linkUrl: string | undefined;
  let addedRuleId: string | undefined;
  let bookableName: string | undefined;

  if (operation === "rename_primary") {
    const newName =
      typeof (params as Record<string, unknown>).name === "string"
        ? ((params as Record<string, unknown>).name as string).trim()
        : "";
    if (!newName) {
      return { success: false, message: `rename_primary requires a "name" param` };
    }
    // Uniqueness: new name must not collide with any office-hours rule name.
    const taken = collectNormalizedLinkNames(existing, undefined, { includeGeneral: false });
    if (taken.has(normalizeNameForGuard(newName))) {
      return {
        success: false,
        message: `You already have a link named "${newName}". Pick a different name.`,
      };
    }
    explicit.primaryLinkName = newName;
    summary = `Renamed primary link to "${newName}"`;
    // Return the primary /meet/{slug} URL so the channel reply can display it.
    if (user?.meetSlug) {
      const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || "https://agentenvoy.ai";
      linkUrl = `${origin}/meet/${user.meetSlug}`;
    }
  } else if (operation === "add") {
    const newId = `rule_${generateCode(8)}`;
    const nowIso = new Date().toISOString();
    const action = (ruleInput!.action as AvailabilityPreference["action"]) ?? "block";

    // Bookable-link-specific validation + population (R1, R4 folds).
    let bookable: AvailabilityPreference["bookable"] | undefined;
    if (action === "bookable") {
      const bookableInput =
        (ruleInput!.bookable as Partial<NonNullable<AvailabilityPreference["bookable"]>> | undefined) ?? {};
      const nameRaw = typeof bookableInput.name === "string" ? bookableInput.name.trim() : "";
      if (!nameRaw) {
        return {
          success: false,
          message: `Bookable Link rules require a name (e.g. "Sales pitch"). Ask the host what to call it.`,
        };
      }
      const taken = collectNormalizedLinkNames(existing, currentGeneralName);
      if (taken.has(normalizeNameForGuard(nameRaw))) {
        return {
          success: false,
          message: `You already have a link named "${nameRaw}". Want to call this one something else?`,
        };
      }
      if (!user?.meetSlug) {
        return {
          success: false,
          message: `Can't create a Bookable Link — your meeting slug isn't set up yet.`,
        };
      }
      const linkCode = generateCode(8);
      const title = typeof bookableInput.title === "string" && bookableInput.title.trim() ? bookableInput.title.trim() : nameRaw;
      bookable = {
        name: nameRaw,
        title,
        format: (bookableInput.format as "video" | "phone" | "in-person" | undefined) ?? "video",
        durationMinutes: typeof bookableInput.durationMinutes === "number" ? bookableInput.durationMinutes : 30,
        linkSlug: user.meetSlug,
        linkCode,
      };
      linkUrl = buildBookableLinkUrl(user.meetSlug, linkCode);
    }

    const rule: AvailabilityPreference = {
      id: newId,
      originalText: String(ruleInput!.originalText ?? "").trim() || "(no description)",
      type: (ruleInput!.type as AvailabilityPreference["type"]) ?? "recurring",
      action,
      timeStart: ruleInput!.timeStart,
      timeEnd: ruleInput!.timeEnd,
      allDay: ruleInput!.allDay,
      daysOfWeek: ruleInput!.daysOfWeek,
      effectiveDate: ruleInput!.effectiveDate,
      expiryDate: ruleInput!.expiryDate,
      bufferMinutesBefore: ruleInput!.bufferMinutesBefore,
      bufferMinutesAfter: ruleInput!.bufferMinutesAfter,
      bufferAppliesTo: ruleInput!.bufferAppliesTo,
      locationLabel: ruleInput!.locationLabel,
      bookable,
      status: "active",
      priority: typeof ruleInput!.priority === "number" ? ruleInput!.priority : 3,
      createdAt: nowIso,
    };
    nextRules = [...existing, rule];
    addedRuleId = newId;
    if (action === "bookable" && bookable) {
      bookableName = bookable.name;
      summary = `Your "${bookable.name}" Bookable Link is ready: ${linkUrl}`;
    } else {
      summary = `Added rule ${newId}`;
    }
  } else if (operation === "update") {
    const idx = existing.findIndex((r) => r.id === id);
    if (idx < 0) return { success: false, message: `No rule found with id ${id}` };
    const prior = existing[idx];
    // Bookable link rename: enforce uniqueness on name change.
    const priorIsBookable = prior.action === "bookable";
    const _ruleInput = ruleInput!;
    const ruleBookableInput = _ruleInput.bookable;
    if (
      priorIsBookable &&
      ruleBookableInput &&
      typeof (ruleBookableInput as { name?: string }).name === "string"
    ) {
      const newName = ((ruleBookableInput as { name?: string }).name ?? "").trim();
      if (newName) {
        const taken = collectNormalizedLinkNames(existing, currentGeneralName, {
          exceptRuleId: prior.id,
        });
        if (taken.has(normalizeNameForGuard(newName))) {
          return {
            success: false,
            message: `You already have a link named "${newName}". Pick a different name.`,
          };
        }
      }
    }
    // Merge: shallow-merge top-level, deep-merge bookable so partial edits
    // (e.g. { bookable: { name: "X" } }) don't drop linkSlug/linkCode.
    const priorBookable = prior.bookable;
    const mergedBookable = ruleBookableInput
      ? { ...(priorBookable ?? {}), ...(ruleBookableInput as object) }
      : prior.bookable;
    const merged: AvailabilityPreference = {
      ...prior,
      ...ruleInput,
      id: prior.id,
      bookable: mergedBookable as AvailabilityPreference["bookable"],
    };
    nextRules = [...existing];
    nextRules[idx] = merged;
    summary = `Updated rule ${id}`;
    if (merged.action === "bookable" && merged.bookable) {
      linkUrl = buildBookableLinkUrl(merged.bookable.linkSlug, merged.bookable.linkCode);
    }
  } else {
    // remove
    const idx = existing.findIndex((r) => r.id === id);
    if (idx < 0) return { success: false, message: `No rule found with id ${id}` };
    const removed = existing[idx];
    nextRules = existing.filter((r) => r.id !== id);
    const removedBookable = removed.bookable;
    summary =
      removed.action === "bookable" && removedBookable
        ? `Removed "${removedBookable.name ?? removedBookable.title}".`
        : `Removed rule ${id}`;
  }

  (explicit as Record<string, unknown>).structuredRules = nextRules;
  const nextPrefs: UserPreferences = { ...prefs, explicit };

  await prisma.user.update({
    where: { id: userId },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });

  const { invalidateSchedule } = await import("@/lib/calendar");
  await invalidateSchedule(userId);
  invalidateBehaviorSnapshot(userId);

  return {
    success: true,
    message: summary,
    data: {
      ...(addedRuleId ? { id: addedRuleId } : id ? { id } : {}),
      ...(linkUrl ? { linkUrl } : {}),
      ...(bookableName ? { bookableName } : {}),
    },
  };
}

// Format inference tokens — parallel to PHYSICAL_ACTIVITY_TOKENS in handleCreateLink.
// Used by handleLockActivityLocation to derive format from a guest-proposed activity.
const VIDEO_ACTIVITY_TOKENS = ["zoom", "video call", "video", "google meet", "teams", "facetime", "meet"];
const PHONE_ACTIVITY_TOKENS = ["phone call", "phone", "call"];

function deriveFormatFromActivity(activityStr: string): "in-person" | "video" | "phone" | null {
  const lower = activityStr.toLowerCase();
  if (PHONE_ACTIVITY_TOKENS.some((t) => lower.includes(t))) return "phone";
  if (VIDEO_ACTIVITY_TOKENS.some((t) => lower.includes(t))) return "video";
  // Physical tokens (subset of PHYSICAL_ACTIVITY_TOKENS in create_link)
  const physicalTokens = [
    "bike", "hike", "run", "walk", "coffee", "lunch", "dinner",
    "breakfast", "drinks", "swim", "workout", "yoga", "trail",
  ];
  if (physicalTokens.some((t) => lower.includes(t))) return "in-person";
  return null;
}

// Format downgrade ladder: in-person > video > phone
// Returns true if `proposed` is a lateral or downward move from `current`.
function isFormatDowngradeOrLateral(current: string, proposed: string): boolean {
  const ladder: Record<string, number> = { "in-person": 2, video: 1, phone: 0 };
  const currentRank = ladder[current] ?? 1;
  const proposedRank = ladder[proposed] ?? 1;
  return proposedRank <= currentRank;
}

/**
 * Lock a guest-negotiated activity and/or location onto the session.
 * Called from the guest-facing deal room when the guest proposes or confirms
 * an activity/location.
 *
 * Validates format changes against the downgrade ladder (in-person > video > phone).
 * Menu picks (activityOptions) always pass — the host pre-approved them.
 *
 * Emits a system-bot thread message for the diff trail.
 *
 * Exported so the MCP guest-side surface (`src/lib/mcp/tools.ts`) can share
 * the same handler — keeps host- and guest-driven negotiation paths on a
 * single code path. See `proposals/2026-04-22_guest-activity-location-
 * negotiation_reviewed-2026-04-22.md` for the original design.
 */
export async function handleLockActivityLocation(
  params: Record<string, unknown>,
  userId: string,
  sessionId?: string
): Promise<ActionResult> {
  const resolvedSessionId = (params.sessionId as string) || sessionId;
  if (!resolvedSessionId) {
    return { success: false, message: "Missing sessionId for lock_activity_location" };
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: resolvedSessionId },
    select: {
      id: true,
      hostId: true,
      status: true,
      link: { select: { id: true, parameters: true } },
    },
  });

  if (!session) return { success: false, message: `Session not found: ${resolvedSessionId}` };
  if (session.hostId !== userId) return { success: false, message: "Not authorized for this session" };
  if (session.status === "agreed") {
    return { success: false, message: "Session is already confirmed — use update_location or update_format for post-confirm changes" };
  }

  const linkRules = parseLinkParameters(session.link?.parameters);
  const hostActivity = typeof linkRules.activity === "string" ? linkRules.activity : null;
  const hostFormat = typeof linkRules.format === "string" ? linkRules.format : null;
  const activityOptions = Array.isArray(linkRules.activityOptions)
    ? (linkRules.activityOptions as string[])
    : null;

  const proposedActivity = typeof params.activity === "string" && params.activity.trim()
    ? params.activity.trim()
    : null;
  const proposedLocation = typeof params.location === "string" && params.location.trim()
    ? params.location.trim()
    : null;

  // Derive format from the proposed activity (or keep current).
  let proposedFormat: string | null = null;
  if (proposedActivity) {
    proposedFormat = deriveFormatFromActivity(proposedActivity);
  }

  // Validate format change against the downgrade ladder, unless this is a
  // menu pick (host pre-approved all options, no ladder check needed).
  if (proposedFormat && hostFormat) {
    const isMenuPick = activityOptions?.some(
      (o) => o.toLowerCase() === proposedActivity?.toLowerCase()
    );
    if (!isMenuPick && !isFormatDowngradeOrLateral(hostFormat, proposedFormat)) {
      return {
        success: false,
        message: `Format upgrade not allowed: host set this up as ${hostFormat} — I can't swap to ${proposedFormat}. The guest can contact the host directly to change the meeting type.`,
      };
    }
  }

  // Write negotiated values to the session.
  await prisma.negotiationSession.update({
    where: { id: resolvedSessionId },
    data: {
      ...(proposedActivity ? { negotiatedActivity: proposedActivity } : {}),
      ...(proposedLocation ? { negotiatedLocation: proposedLocation } : {}),
      ...(proposedFormat ? { negotiatedFormat: proposedFormat } : {}),
      negotiatedLockedBy: "guest",
    },
  });

  // Emit a system-bot message as the diff trail (visible to both host and guest).
  const parts: string[] = [];
  if (proposedActivity && proposedActivity !== hostActivity) parts.push(proposedActivity);
  if (proposedLocation) parts.push(`at ${proposedLocation}`);
  const lockSummary = parts.length > 0 ? parts.join(" ") : proposedActivity ?? proposedLocation ?? "details";

  await prisma.message.create({
    data: {
      sessionId: resolvedSessionId,
      role: "system",
      content: `✓ Locked in: ${lockSummary} (set by guest)`,
      metadata: { kind: "activity_location_lock", lockedBy: "guest" } as Prisma.InputJsonValue,
    },
  });

  return {
    success: true,
    message: `Locked: ${lockSummary}`,
    data: {
      negotiatedActivity: proposedActivity,
      negotiatedLocation: proposedLocation,
      negotiatedFormat: proposedFormat,
      lockedBy: "guest",
    },
  };
}

/**
 * `lock_session_duration` — guest-initiated meeting-duration negotiation.
 *
 * Mirrors `handleLockActivityLocation` for the duration dimension. Validates
 * the proposed duration against the host's `guestPicks.duration` opt-in
 * (boolean = static cap [15, 240]; number array = allow-list match), writes
 * `negotiatedDuration` and `negotiatedLockedBy: "guest"`, and emits a
 * system-bot diff message to the thread.
 *
 * Read at slot-search and confirm time as
 *   session.negotiatedDuration ?? link.parameters.duration
 * Cleared by handleUpdateLinkRules / availability-rules edit / primary-link
 * defaults change when the host edits the parent link's duration.
 *
 * The MCP-equivalent path is `propose_lock.overrides.duration` — both end at
 * `session.negotiatedDuration`. Keep them aligned: changes to validation
 * here should mirror to the MCP override validation path.
 *
 * Returns `data.refetchSlots: true` on success so the deal-room re-fetches
 * `/api/negotiate/slots` — duration is the only dimension where guest
 * negotiation invalidates the slot pre-compute (slots that fit 30 min may
 * not fit 60), unlike activity / location / format where the slot universe
 * is unchanged.
 *
 * Reusable-link guest-picks proposal, decided 2026-04-28.
 */
async function handleLockSessionDuration(
  params: Record<string, unknown>,
  userId: string,
  sessionId?: string
): Promise<ActionResult> {
  const resolvedSessionId = (params.sessionId as string) || sessionId;
  if (!resolvedSessionId) {
    return { success: false, message: "Missing sessionId for lock_session_duration" };
  }

  const durationMinutes = typeof params.durationMinutes === "number"
    ? params.durationMinutes
    : typeof params.duration === "number"
      ? params.duration
      : null;
  if (durationMinutes === null || !Number.isFinite(durationMinutes) || !Number.isInteger(durationMinutes)) {
    return { success: false, message: "lock_session_duration requires integer durationMinutes" };
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: resolvedSessionId },
    select: {
      id: true,
      hostId: true,
      status: true,
      link: { select: { id: true, parameters: true } },
    },
  });

  if (!session) return { success: false, message: `Session not found: ${resolvedSessionId}` };
  if (session.hostId !== userId) return { success: false, message: "Not authorized for this session" };
  if (session.status === "agreed") {
    return { success: false, message: "Session is already confirmed — duration cannot be re-negotiated post-confirm" };
  }

  const linkRules = parseLinkParameters(session.link?.parameters);
  const guestPicksDuration = linkRules.guestPicks?.duration;

  // Defense in depth: composer should already have refused if guestPicks.duration
  // is not set, but enforce here too. The host hasn't opted in → refuse.
  if (guestPicksDuration === undefined || guestPicksDuration === false) {
    return {
      success: false,
      message:
        "This link doesn't allow guests to change duration. Refuse the proposal in chat without acknowledging the change.",
    };
  }

  // Allow-list form: duration must be in the host's explicit list.
  if (Array.isArray(guestPicksDuration)) {
    if (!guestPicksDuration.includes(durationMinutes)) {
      return {
        success: false,
        message: `Duration ${durationMinutes} is not in the host's allowed list (${guestPicksDuration.join(", ")}). Refuse with: "${session.link?.parameters ? "" : ""}John offers ${guestPicksDuration.join(", ")} — pick one of those."`,
      };
    }
  } else {
    // Boolean true → static cap.
    if (durationMinutes < GUEST_PICKS_DURATION_MIN_MINUTES) {
      return {
        success: false,
        message: `Duration ${durationMinutes} is below the minimum of ${GUEST_PICKS_DURATION_MIN_MINUTES} minutes. Refuse with: "${GUEST_PICKS_DURATION_MIN_MINUTES} minutes is the shortest I can lock in."`,
      };
    }
    if (durationMinutes > GUEST_PICKS_DURATION_MAX_MINUTES) {
      const maxHours = GUEST_PICKS_DURATION_MAX_MINUTES / 60;
      return {
        success: false,
        message: `Duration ${durationMinutes} exceeds the maximum of ${GUEST_PICKS_DURATION_MAX_MINUTES} minutes. Refuse with: "${durationMinutes} minutes is more than I can lock in — most I can do is ${maxHours} hours."`,
      };
    }
  }

  const hostDuration = typeof linkRules.duration === "number" ? linkRules.duration : null;

  // Idempotent: if the proposed value matches the current locked value or the
  // host's default with no prior lock, no-op gracefully (success, but no
  // state change and no system-bot message).
  if (durationMinutes === hostDuration) {
    return {
      success: true,
      message: `Duration ${durationMinutes} matches the host's default — no change needed.`,
      data: { refetchSlots: false },
    };
  }

  await prisma.negotiationSession.update({
    where: { id: resolvedSessionId },
    data: {
      negotiatedDuration: durationMinutes,
      negotiatedLockedBy: "guest",
    },
  });

  // System-bot diff message — visible to both host and guest.
  const hostDurationLabel = hostDuration ? `, default was ${hostDuration} min` : "";
  await prisma.message.create({
    data: {
      sessionId: resolvedSessionId,
      role: "system",
      content: `✓ Duration set to ${durationMinutes} minutes (set by guest${hostDurationLabel})`,
      metadata: { kind: "session_duration_lock", lockedBy: "guest", durationMinutes } as Prisma.InputJsonValue,
    },
  });

  return {
    success: true,
    message: `Locked: ${durationMinutes} min`,
    data: {
      negotiatedDuration: durationMinutes,
      lockedBy: "guest",
      // Signal to the deal-room UI that slot pre-compute is invalid for the
      // new duration — refetch /api/negotiate/slots before showing the picker.
      refetchSlots: true,
    },
  };
}
