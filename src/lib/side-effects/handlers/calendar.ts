/**
 * Calendar handler for the side-effect dispatcher.
 *
 * Wraps Google Calendar writes (`events.insert`, `events.delete`) for three
 * distinct kinds:
 *   - `calendar.create_event` — a confirmed meeting with attendees
 *   - `calendar.create_hold`  — a tentative hold (no attendees, no notifications)
 *   - `calendar.delete_event` — cancel an event by id
 *
 * Modes:
 *   live       — call Google Calendar for real
 *   allowlist  — (not supported for calendar — behaves like live on the host's own calendar)
 *   log        — record the payload, return null IDs
 *   dryrun     — same as log, but synthesize plausible IDs + meet link so
 *                upstream confirm/hold flows can continue end-to-end on preview
 *   off        — no-op
 *
 * `sendUpdates` control: in `live` mode the handler reads CALENDAR_SEND_UPDATES
 * (default "all") unless the caller overrides it. This is the safety belt that
 * the spec calls for — if someone flips preview to `live` by accident, setting
 * CALENDAR_SEND_UPDATES=none on that env keeps real invitations from going out.
 *
 * See RISK-MANAGEMENT.md §Phase 2.
 */

import { getGoogleCalendarClient } from "@/lib/calendar";
import type {
  CalendarCreateEventEffect,
  CalendarCreateHoldEffect,
  CalendarDeleteEventEffect,
  CalendarUpdateEventEffect,
  EffectMode,
  EffectStatus,
} from "../types";

/** Shared outcome shape the dispatcher stitches onto a result. */
export interface CalendarHandlerOutcome {
  status: EffectStatus;
  effectiveMode: EffectMode;
  eventId?: string | null;
  htmlLink?: string | null;
  meetLink?: string | null;
  error?: string;
}

function sendUpdatesDefault(): "all" | "externalOnly" | "none" {
  const raw = (process.env.CALENDAR_SEND_UPDATES || "all").toLowerCase();
  if (raw === "none" || raw === "externalonly") {
    return raw === "externalonly" ? "externalOnly" : "none";
  }
  return "all";
}

// ─────────────────────────────────────────────────────────────────────────────
// calendar.create_event
// ─────────────────────────────────────────────────────────────────────────────

export async function handleCalendarCreateEvent(
  effect: CalendarCreateEventEffect,
  mode: EffectMode,
): Promise<CalendarHandlerOutcome> {
  if (mode === "off") {
    return { status: "skipped", effectiveMode: "off", eventId: null, htmlLink: null, meetLink: null };
  }

  if (mode === "log") {
    return { status: "suppressed", effectiveMode: "log", eventId: null, htmlLink: null, meetLink: null };
  }

  if (mode === "dryrun") {
    const fake = crypto.randomUUID();
    return {
      status: "dryrun",
      effectiveMode: "dryrun",
      eventId: `dryrun-${fake}`,
      htmlLink: `https://calendar.google.com/calendar/r/eventedit/dryrun-${fake}`,
      meetLink: effect.addMeetLink
        ? `https://meet.google.com/dryrun-${fake.slice(0, 11)}`
        : null,
    };
  }

  // live / allowlist — allowlist has no meaningful semantics for a calendar on
  // the host's own account, so we treat it as live.
  try {
    const calendar = await getGoogleCalendarClient(effect.userId);
    const event = {
      summary: effect.summary,
      description: effect.description,
      start: { dateTime: effect.startTime.toISOString() },
      end: { dateTime: effect.endTime.toISOString() },
      attendees: effect.attendeeEmails.map((email) => ({ email })),
      ...(effect.sessionId && {
        extendedProperties: { private: { agentenvoySessionId: effect.sessionId } },
      }),
      ...(effect.addMeetLink && {
        conferenceData: {
          createRequest: {
            requestId: `agentenvoy-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
    };

    const sendUpdates = effect.sendUpdatesOverride || sendUpdatesDefault();

    const { data } = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
      conferenceDataVersion: effect.addMeetLink ? 1 : 0,
      sendUpdates,
    });

    return {
      status: "sent",
      effectiveMode: mode,
      eventId: data.id ?? null,
      htmlLink: data.htmlLink ?? null,
      meetLink:
        data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
        null,
    };
  } catch (err) {
    return {
      status: "failed",
      effectiveMode: mode,
      eventId: null,
      htmlLink: null,
      meetLink: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// calendar.create_hold
// ─────────────────────────────────────────────────────────────────────────────

export async function handleCalendarCreateHold(
  effect: CalendarCreateHoldEffect,
  mode: EffectMode,
): Promise<CalendarHandlerOutcome> {
  if (mode === "off") {
    return { status: "skipped", effectiveMode: "off", eventId: null, htmlLink: null };
  }

  if (mode === "log") {
    return { status: "suppressed", effectiveMode: "log", eventId: null, htmlLink: null };
  }

  if (mode === "dryrun") {
    const fake = crypto.randomUUID();
    return {
      status: "dryrun",
      effectiveMode: "dryrun",
      eventId: `dryrun-hold-${fake}`,
      htmlLink: null,
    };
  }

  try {
    const calendar = await getGoogleCalendarClient(effect.userId);
    const { data } = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: effect.summary,
        description: effect.description,
        start: { dateTime: effect.startTime.toISOString() },
        end: { dateTime: effect.endTime.toISOString() },
        status: "tentative",
        transparency: "opaque",
      },
      sendUpdates: "none",
    });
    return {
      status: "sent",
      effectiveMode: mode,
      eventId: data.id ?? null,
      htmlLink: data.htmlLink ?? null,
    };
  } catch (err) {
    return {
      status: "failed",
      effectiveMode: mode,
      eventId: null,
      htmlLink: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// calendar.delete_event
// ─────────────────────────────────────────────────────────────────────────────

export async function handleCalendarDeleteEvent(
  effect: CalendarDeleteEventEffect,
  mode: EffectMode,
): Promise<CalendarHandlerOutcome> {
  if (mode === "off") {
    return { status: "skipped", effectiveMode: "off" };
  }

  if (mode === "log") {
    return { status: "suppressed", effectiveMode: "log" };
  }

  if (mode === "dryrun") {
    // Nothing to synthesize — delete has no meaningful return.
    return { status: "dryrun", effectiveMode: "dryrun" };
  }

  try {
    const calendar = await getGoogleCalendarClient(effect.userId);
    await calendar.events.delete({
      calendarId: "primary",
      eventId: effect.eventId,
      sendUpdates: effect.notifyAttendees ? "all" : "none",
    });
    return { status: "sent", effectiveMode: mode };
  } catch (err) {
    const e = err as { code?: number; response?: { status?: number }; message?: string };
    const status = e?.code ?? e?.response?.status;
    // Already gone — treat as success. Matches the previous deleteCalendarEvent semantics.
    if (status === 404 || status === 410) {
      return { status: "sent", effectiveMode: mode };
    }
    return {
      status: "failed",
      effectiveMode: mode,
      error: e?.message || String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Target summaries — for SideEffectLog.targetSummary
// ─────────────────────────────────────────────────────────────────────────────

export function summarizeCalendarCreateEventTarget(effect: CalendarCreateEventEffect): string {
  const count = effect.attendeeEmails.length;
  const when = effect.startTime.toISOString().slice(0, 16).replace("T", " ");
  return `${effect.summary} · ${when}Z · ${count} attendee${count === 1 ? "" : "s"}`;
}

export function summarizeCalendarCreateHoldTarget(effect: CalendarCreateHoldEffect): string {
  const when = effect.startTime.toISOString().slice(0, 16).replace("T", " ");
  return `HOLD · ${effect.summary} · ${when}Z`;
}

export function summarizeCalendarDeleteEventTarget(effect: CalendarDeleteEventEffect): string {
  return `delete ${effect.eventId}${effect.notifyAttendees ? " (notify)" : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// calendar.update_event
// ─────────────────────────────────────────────────────────────────────────────

export async function handleCalendarUpdateEvent(
  effect: CalendarUpdateEventEffect,
  mode: EffectMode,
): Promise<CalendarHandlerOutcome> {
  if (mode === "off") {
    return { status: "skipped", effectiveMode: "off", eventId: null, htmlLink: null };
  }

  if (mode === "log") {
    return { status: "suppressed", effectiveMode: "log", eventId: null, htmlLink: null };
  }

  if (mode === "dryrun") {
    return {
      status: "dryrun",
      effectiveMode: "dryrun",
      eventId: effect.eventId,
      htmlLink: `https://calendar.google.com/calendar/r/eventedit/${effect.eventId}`,
    };
  }

  try {
    const calendar = await getGoogleCalendarClient(effect.userId);
    const { changes } = effect;

    // Build a sparse PATCH body — only include fields that are explicitly changing
    const patch: Record<string, unknown> = {};
    if (changes.summary !== undefined) patch.summary = changes.summary;
    if (changes.description !== undefined) patch.description = changes.description;
    if (changes.location !== undefined) {
      // null means clear the field; Google API requires empty string for that
      patch.location = changes.location ?? "";
    }
    if (changes.startTime !== undefined) {
      patch.start = { dateTime: changes.startTime.toISOString() };
    }
    if (changes.endTime !== undefined) {
      patch.end = { dateTime: changes.endTime.toISOString() };
    }

    const sendUpdates = effect.sendUpdatesOverride
      || (effect.notifyAttendees ? sendUpdatesDefault() : "none");

    const { data } = await calendar.events.patch({
      calendarId: "primary",
      eventId: effect.eventId,
      requestBody: patch,
      sendUpdates,
    });

    return {
      status: "sent",
      effectiveMode: mode,
      eventId: data.id ?? null,
      htmlLink: data.htmlLink ?? null,
    };
  } catch (err) {
    return {
      status: "failed",
      effectiveMode: mode,
      eventId: null,
      htmlLink: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function summarizeCalendarUpdateEventTarget(effect: CalendarUpdateEventEffect): string {
  const parts: string[] = [`update ${effect.eventId}`];
  if (effect.changes.startTime) parts.push(effect.changes.startTime.toISOString().slice(0, 16).replace("T", " ") + "Z");
  if (effect.changes.location !== undefined) parts.push(`loc:${effect.changes.location ?? "(cleared)"}`);
  if (effect.notifyAttendees) parts.push("notify");
  return parts.join(" · ");
}
