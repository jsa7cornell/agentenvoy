/**
 * UpdateConfirmedMeeting — single helper for in-place edits to a confirmed
 * meeting's location / format / time / duration.
 *
 * Replaces the three duplicate write paths that previously did this work:
 *   - `/api/negotiate/update-gcal/route.ts` (HTTP, from the reschedule picker)
 *   - `applyConfirmedSessionPatch()` in `agent/actions.ts` (in-chat updates)
 *   - inline GCal-patch logic in `deal-room.tsx`'s `proposeFromSlot` branch
 *
 * Each had its own subtly-different rules for which DB columns to write,
 * which fields to mirror to `link.parameters`, and what trust model to
 * enforce — producing six drift bugs in one session (2026-05-11). See
 * `agentenvoy/proposals/2026-05-11_update-confirmed-meeting_reviewed-2026-05-11_decided-2026-05-11.md`
 * for the full decision rationale.
 *
 * Scope (decided): in-place `status: "agreed"` edits only. NOT first-confirm
 * (`confirmBooking` stays separate), NOT cancellation, NOT group sessions
 * (fast-refuses with `group_session_not_supported`).
 *
 * Semantics: partial-state update (HTTP PATCH-style). For each key in
 * `changes`, the supplied value is written. Absent keys leave the current
 * value alone — no auto-rederive from sibling field changes.
 */
import { prisma } from "@/lib/prisma";
import {
  assertAgentEnvoyOwnedEvent,
  GcalOwnershipError,
  updateCalendarEvent,
} from "@/lib/calendar";
import { parseLinkParameters } from "@/lib/link-parameters";
import type { Prisma } from "@prisma/client";

// ── Public types ─────────────────────────────────────────────────────────────

export type MeetingChanges = {
  /** `null` clears the field on the GCal event + DB + link.parameters. */
  location?: string | null;
  format?: "phone" | "video" | "in-person";
  /** Helper writes BOTH `agreedTime` AND `confirmedAt` from this value. */
  startTime?: Date;
  /** Optional; derived from startTime + duration when absent. */
  endTime?: Date;
  duration?: number;
};

export type UpdateOpts = {
  /**
   * Two-axis actor info. `invoker` is who literally called the helper;
   * `triggeringRole` is who initiated the chat message / picker click that
   * led here, when the invoker is the agent or a system path. For host-typed
   * chat handled by the agent: `{ invoker: "agent", triggeringRole: "host" }`.
   * For host clicks on the reschedule picker: `{ invoker: "host" }`.
   */
  actor: {
    invoker: "host" | "guest" | "agent" | "system";
    triggeringRole?: "host" | "guest";
  };
  /**
   * GCal `sendUpdates` for the patch. Defaults to false — silent edits
   * match the existing post-confirm in-chat behavior. Callers can opt in
   * when they want an email blast to attendees.
   */
  notifyAttendees?: boolean;
  /**
   * Override for the thread system message. Absent → helper auto-derives
   * from the resolved changes (e.g. "Location updated to X", "Moved to Tue
   * Apr 3 at 3:00 PM").
   */
  systemMessageOverride?: string;
};

export type RefusalReason =
  | "session_not_found"
  | "session_not_agreed"
  | "session_archived"
  | "no_calendar_event"
  | "past_start_time"
  | "ownership_mismatch"
  | "gcal_failed"
  | "invalid_format"
  | "group_session_not_supported";

export type ResolvedMeetingState = {
  location: string | null;
  format: "phone" | "video" | "in-person";
  startTime: Date;
  endTime: Date;
  duration: number;
};

export type UpdateResult =
  | {
      ok: true;
      resolved: ResolvedMeetingState;
      gcalEventId: string;
      gcalHtmlLink: string | null;
    }
  | { ok: false; reason: RefusalReason; message: string };

// ── Internal types ───────────────────────────────────────────────────────────

type LoadedSession = {
  id: string;
  hostId: string;
  status: string;
  archived: boolean;
  calendarEventId: string | null;
  agreedTime: Date | null;
  agreedFormat: string | null;
  duration: number | null;
  link: {
    id: string;
    type: string;
    mode: string | null;
    parameters: unknown;
  };
};

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Load + validate a session for in-place edit. Shared by `resolveMeetingState`
 * and `updateConfirmedMeeting` so refusal shapes stay 1:1.
 */
async function loadAndGate(
  sessionId: string,
): Promise<{ ok: true; session: LoadedSession } | { ok: false; reason: RefusalReason; message: string }> {
  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      hostId: true,
      status: true,
      archived: true,
      calendarEventId: true,
      agreedTime: true,
      agreedFormat: true,
      duration: true,
      link: { select: { id: true, type: true, mode: true, parameters: true } },
    },
  });
  if (!session) {
    return { ok: false, reason: "session_not_found", message: `Session not found: ${sessionId}` };
  }
  if (session.archived) {
    return { ok: false, reason: "session_archived", message: "Session is archived." };
  }
  if (session.status !== "agreed") {
    return {
      ok: false,
      reason: "session_not_agreed",
      message: `Session is not in a confirmed state (status=${session.status}).`,
    };
  }
  if (!session.calendarEventId) {
    return {
      ok: false,
      reason: "no_calendar_event",
      message: "Session has no calendar event to patch.",
    };
  }
  if (session.link.mode === "group") {
    // Group sessions fan-out across multiple participant rows; this helper
    // writes to one row. Deferred to a follow-up proposal — refuse cleanly
    // rather than silently corrupting state.
    return {
      ok: false,
      reason: "group_session_not_supported",
      message: "Group sessions are not supported by updateConfirmedMeeting yet.",
    };
  }
  return { ok: true, session: session as LoadedSession };
}

/**
 * Resolve the new meeting state from current DB values + supplied changes.
 *
 * Partial-state semantics: for each field in `changes`, the supplied value
 * wins (including `null` for `location` which clears it). For absent fields,
 * the current DB value is preserved. No auto-rederive — a format flip from
 * video → in-person does NOT pull `link.parameters.location` unless the
 * caller explicitly asks for that (by omitting `location` and supplying a
 * fallback override; this helper does not implement the override today —
 * just keeps current).
 *
 * Returned `endTime` is derived from `startTime + duration` when both are
 * known and `endTime` is absent in changes.
 */
export async function resolveMeetingState(
  sessionId: string,
  changes: MeetingChanges,
): Promise<
  | { ok: true; resolved: ResolvedMeetingState }
  | { ok: false; reason: RefusalReason; message: string }
> {
  const gate = await loadAndGate(sessionId);
  if (!gate.ok) return gate;
  const { session } = gate;

  // Current values from DB / link.parameters fallback. These mirror the
  // renderer's chain in `dealRoomToMeetingCardProps.ts:247-250` so the
  // server's authoritative state stays a superset of what the UI reads.
  const linkParams = parseLinkParameters(session.link.parameters);
  const currentLocation =
    typeof linkParams.location === "string" && linkParams.location.trim()
      ? linkParams.location.trim()
      : null;
  const currentFormat = (session.agreedFormat ?? "video") as
    | "phone"
    | "video"
    | "in-person";
  const currentStartTime = session.agreedTime ?? new Date();
  const currentDuration = session.duration ?? 30;

  // Apply partial changes. `null` for location is meaningful (= clear).
  const resolvedFormat: "phone" | "video" | "in-person" =
    changes.format !== undefined ? changes.format : currentFormat;
  const resolvedLocation: string | null =
    "location" in changes ? changes.location ?? null : currentLocation;
  const resolvedStartTime =
    changes.startTime !== undefined ? changes.startTime : currentStartTime;
  const resolvedDuration =
    changes.duration !== undefined ? changes.duration : currentDuration;
  const resolvedEndTime =
    changes.endTime !== undefined
      ? changes.endTime
      : new Date(resolvedStartTime.getTime() + resolvedDuration * 60 * 1000);

  // Format validation — Zod schemas at the route boundary catch this but
  // call sites that pass through unchecked typed input get the same gate.
  if (!["phone", "video", "in-person"].includes(resolvedFormat)) {
    return {
      ok: false,
      reason: "invalid_format",
      message: `Invalid format: ${resolvedFormat}.`,
    };
  }

  return {
    ok: true,
    resolved: {
      location: resolvedLocation,
      format: resolvedFormat,
      startTime: resolvedStartTime,
      endTime: resolvedEndTime,
      duration: resolvedDuration,
    },
  };
}

/**
 * Auto-derive the thread system message text from the supplied changes.
 * Multi-field changes get concatenated with " · ".
 */
function deriveSystemMessage(
  changes: MeetingChanges,
  resolved: ResolvedMeetingState,
): string {
  const parts: string[] = [];
  if ("location" in changes) {
    parts.push(
      resolved.location
        ? `Location updated to ${resolved.location}`
        : "Location cleared",
    );
  }
  if (changes.format !== undefined) {
    parts.push(`Format updated to ${resolved.format}`);
  }
  if (changes.startTime !== undefined) {
    const whenLabel = resolved.startTime.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    parts.push(`Moved to ${whenLabel}`);
  }
  if (changes.duration !== undefined && changes.startTime === undefined) {
    // Duration-only edit; keep separate from the "Moved to" line above.
    parts.push(`Duration updated to ${resolved.duration} min`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Meeting updated";
}

/**
 * List the metadata.fields[] for the thread system message. Same set the
 * caller-visible summary covers — feedback bundles can filter by field.
 */
function listChangedFields(changes: MeetingChanges): string[] {
  const fields: string[] = [];
  if ("location" in changes) fields.push("location");
  if (changes.format !== undefined) fields.push("format");
  if (changes.startTime !== undefined) fields.push("time");
  if (changes.duration !== undefined && changes.startTime === undefined) {
    fields.push("duration");
  }
  return fields;
}

/**
 * Mirror writable fields to `link.parameters` for personalized links.
 * Non-personalized links (primary / bookable templates) are unaffected —
 * their parameters describe the offer, not a specific session's state.
 */
async function mirrorToLinkParameters(
  link: { id: string; type: string; parameters: unknown },
  changes: MeetingChanges,
  resolved: ResolvedMeetingState,
): Promise<void> {
  if (link.type !== "personalized") return;
  const mirror: Record<string, unknown> = {};
  if ("location" in changes) mirror.location = resolved.location;
  if (changes.format !== undefined) mirror.format = resolved.format;
  if (changes.duration !== undefined) mirror.duration = resolved.duration;
  if (Object.keys(mirror).length === 0) return;
  const existing = parseLinkParameters(link.parameters);
  const next: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(mirror)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  await prisma.negotiationLink.update({
    where: { id: link.id },
    data: { parameters: next as Prisma.InputJsonValue },
  });
}

/**
 * Apply an in-place patch to a confirmed meeting. Single source of truth for:
 *   - DB write: agreedTime, confirmedAt, agreedFormat, session.format,
 *     duration, statusLabel, gcalHtmlLink. Guarded by `updateMany WHERE
 *     status="agreed" AND !archived` (TOCTOU safety).
 *   - GCal patch via the side-effect dispatcher (`events.patch`).
 *   - `link.parameters` mirror for personalized links.
 *   - Thread system message with `actor` metadata for audit replay.
 *
 * Pure function shape: takes inputs, returns a typed `UpdateResult`. Does
 * not throw on operational failures (GCal 4xx/5xx, ownership mismatch) —
 * returns `ok: false` with a typed `RefusalReason`. Unexpected exceptions
 * (DB connection loss, etc.) bubble up to the caller.
 */
export async function updateConfirmedMeeting(
  sessionId: string,
  changes: MeetingChanges,
  opts: UpdateOpts,
): Promise<UpdateResult> {
  // Empty changes — no-op short-circuit. Still returns the current resolved
  // state so callers can compute optimistic updates against it.
  const hasChanges =
    "location" in changes ||
    changes.format !== undefined ||
    changes.startTime !== undefined ||
    changes.endTime !== undefined ||
    changes.duration !== undefined;
  if (!hasChanges) {
    const resolved = await resolveMeetingState(sessionId, {});
    if (!resolved.ok) return resolved;
    // Need the eventId/htmlLink for the result shape. Re-read once.
    const sess = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      select: { calendarEventId: true, gcalHtmlLink: true },
    });
    return {
      ok: true,
      resolved: resolved.resolved,
      gcalEventId: sess?.calendarEventId ?? "",
      gcalHtmlLink: sess?.gcalHtmlLink ?? null,
    };
  }

  const resolution = await resolveMeetingState(sessionId, changes);
  if (!resolution.ok) return resolution;
  const { resolved } = resolution;

  // Re-load the session because resolveMeetingState's gate already validated
  // it but we need calendarEventId + link below. The double-load is one
  // extra query; acceptable for now (helper is on the write path, not hot).
  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      hostId: true,
      calendarEventId: true,
      link: { select: { id: true, type: true, parameters: true } },
    },
  });
  if (!session || !session.calendarEventId) {
    // Should be unreachable post-gate, but the TS narrowing requires it.
    return {
      ok: false,
      reason: "no_calendar_event",
      message: "Calendar event disappeared between gate and patch.",
    };
  }

  // Past-time guard. Applied AFTER resolution so it catches both supplied
  // startTime AND the resolved one (which is just the supplied one given
  // partial semantics, but the gate is explicit).
  if (changes.startTime !== undefined && resolved.startTime <= new Date()) {
    return {
      ok: false,
      reason: "past_start_time",
      message: "Proposed start time is in the past.",
    };
  }

  // Ownership gate — event must carry this session's agentenvoy tag.
  try {
    await assertAgentEnvoyOwnedEvent(
      session.hostId,
      session.calendarEventId,
      session.id,
    );
  } catch (err) {
    if (err instanceof GcalOwnershipError) {
      return { ok: false, reason: "ownership_mismatch", message: err.message };
    }
    throw err;
  }

  // GCal patch — outside any prisma transaction (B1 safety from update-gcal).
  // Only include fields the caller asked to change so we don't stomp other
  // GCal state.
  const gcalChanges: Parameters<typeof updateCalendarEvent>[3] = {};
  if ("location" in changes) gcalChanges.location = resolved.location;
  if (changes.startTime !== undefined) gcalChanges.startTime = resolved.startTime;
  if (
    changes.endTime !== undefined ||
    changes.startTime !== undefined ||
    changes.duration !== undefined
  ) {
    gcalChanges.endTime = resolved.endTime;
  }

  let gcalResult: { eventId: string | null; htmlLink: string | null };
  try {
    gcalResult = await updateCalendarEvent(
      session.hostId,
      session.calendarEventId,
      session.id,
      gcalChanges,
      { notifyAttendees: opts.notifyAttendees ?? false },
    );
  } catch (err) {
    return {
      ok: false,
      reason: "gcal_failed",
      message: `Calendar update failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  // DB write — TOCTOU-guarded updateMany. Only fields in `changes` get
  // touched on the session row.
  const dbUpdates: Record<string, unknown> = {};
  if ("location" in changes) {
    dbUpdates.statusLabel = resolved.location
      ? `Location updated to ${resolved.location}`
      : "Location cleared";
  }
  if (changes.startTime !== undefined) {
    dbUpdates.confirmedAt = resolved.startTime;
    dbUpdates.agreedTime = resolved.startTime;
  }
  if (changes.duration !== undefined) {
    dbUpdates.duration = resolved.duration;
  }
  if (changes.format !== undefined) {
    dbUpdates.format = resolved.format;
    dbUpdates.agreedFormat = resolved.format;
  }
  if (gcalResult.htmlLink) {
    dbUpdates.gcalHtmlLink = gcalResult.htmlLink;
  }
  if (Object.keys(dbUpdates).length > 0) {
    await prisma.negotiationSession.updateMany({
      where: { id: sessionId, status: "agreed", archived: false },
      data: dbUpdates as Parameters<
        typeof prisma.negotiationSession.updateMany
      >[0]["data"],
    });
  }

  // Mirror to link.parameters for personalized links.
  await mirrorToLinkParameters(session.link, changes, resolved);

  // Thread system message with actor metadata.
  const summary = opts.systemMessageOverride ?? deriveSystemMessage(changes, resolved);
  const fields = listChangedFields(changes);
  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "system",
      content: summary,
      metadata: {
        kind: "host_update",
        fields,
        // Single-field shape preserved for back-compat with existing
        // renderers that read `metadata.field` (singular).
        ...(fields.length === 1 ? { field: fields[0] } : {}),
        actor: opts.actor,
      } as Prisma.InputJsonValue,
    },
  });

  return {
    ok: true,
    resolved,
    gcalEventId: gcalResult.eventId ?? session.calendarEventId,
    gcalHtmlLink: gcalResult.htmlLink,
  };
}
