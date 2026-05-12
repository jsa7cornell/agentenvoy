/**
 * Session-state helpers for the deal-room unified agent (Phase A.3).
 *
 * These exist so the new deal-room tools (`session_set_status`,
 * `session_request_reschedule`) have a clean callable surface that doesn't
 * duplicate route logic. The legacy `/api/negotiate/message` `[STATUS_UPDATE]`
 * parsing and the `/api/negotiate/reschedule` route POST handler can converge
 * on these helpers in a follow-up (when Phase D retires the legacy routes
 * those callers go away naturally).
 *
 * NOT a grab-bag — single-purpose: session-state mutations that survive
 * Phase D's retire-now sweep because they're called by both the legacy
 * routes (until retired) and the new deal-room runner.
 *
 * Refs: proposals/2026-05-11_complete-unified-agent-migration-and-retire-classifier-composer_reviewed-2026-05-11_decided-2026-05-11.md §3.2
 */

import { prisma } from "@/lib/prisma";
import { deleteCalendarEvent, invalidateSchedule } from "@/lib/calendar";

/**
 * Statuses `session_set_status` accepts. Mirrors the legacy
 * `negotiate/message/route.ts:29 VALID_STATUSES`, widened with `"skipped"`
 * per Round 2 RN2 of the deal-room migration proposal — the new MeetingCard
 * at `dealRoomToMeetingCardProps.ts:140` recognizes that state for the
 * recurring-session skip UI.
 *
 * Intentionally excludes `"agreed"` — that transition is the
 * `confirm-pipeline`'s exclusive write (no other path enters agreed state
 * cleanly). See the SPEC §2.3.1 invariant.
 */
export const SESSION_SET_STATUS_VALUES = [
  "active",
  "proposed",
  "cancelled",
  "escalated",
  "skipped",
] as const;
export type SessionSetStatusValue = (typeof SESSION_SET_STATUS_VALUES)[number];

export type SetSessionStatusInput = {
  sessionId: string;
  status: SessionSetStatusValue;
  /** Short human-readable note; max 60 chars per the legacy convention. */
  label?: string;
};

export type SetSessionStatusResult =
  | { success: true; status: SessionSetStatusValue; statusLabel: string | null }
  | { success: false; reason: "session_not_found" | "invalid_status" };

/**
 * Flip a session's status and label. Preserves SPEC §2.3.1: when the new
 * status is anything other than `agreed` (and this function refuses `agreed`),
 * `agreedTime` + `agreedFormat` are cleared on the same write so the
 * deal-room never reads a stale agreed-state pair.
 *
 * Mirrors the inline write at `negotiate/message/route.ts:533-541` — the
 * deal-room runner (Phase A.4) calls this instead of duplicating the logic;
 * the legacy route stays unchanged until Phase D retirement.
 */
export async function setSessionStatus(
  input: SetSessionStatusInput,
): Promise<SetSessionStatusResult> {
  if (!SESSION_SET_STATUS_VALUES.includes(input.status)) {
    return { success: false, reason: "invalid_status" };
  }
  const exists = await prisma.negotiationSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true },
  });
  if (!exists) return { success: false, reason: "session_not_found" };
  const label = input.label ?? null;
  await prisma.negotiationSession.update({
    where: { id: input.sessionId },
    data: {
      status: input.status,
      statusLabel: label,
      // SPEC §2.3.1: clear agreed-state pair on every transition that lands
      // here. `confirm-pipeline.confirmBooking` is the only path that writes
      // them; this function never enters `agreed` state so clearing is safe.
      agreedTime: null,
      agreedFormat: null,
    },
  });
  return { success: true, status: input.status, statusLabel: label };
}

export type RequestRescheduleInput = {
  sessionId: string;
  /** Who initiated. Distinguishes system-message wording + statusLabel. */
  initiator: "host" | "guest";
};

export type RequestRescheduleResult =
  | { success: true; calendarEventCleared: boolean }
  | { success: false; reason: "session_not_found" | "not_in_agreed_state" };

/**
 * Reset a confirmed meeting back to active negotiation. Deletes the GCal
 * event (notifying attendees), releases active holds, invalidates the
 * schedule cache, and clears agreed-state fields.
 *
 * Mirrors `/api/negotiate/reschedule/route.ts:50-118` exactly. The new
 * `session_request_reschedule` tool calls this helper; the legacy route
 * will converge here in a follow-up. SPEC §2.3.2 invariant: `calendarEventId`
 * is cleared HERE because this IS the cancel-pipeline for the prior agreed
 * event — same semantic as the legacy route.
 */
export async function requestSessionReschedule(
  input: RequestRescheduleInput,
): Promise<RequestRescheduleResult> {
  const negotiation = await prisma.negotiationSession.findUnique({
    where: { id: input.sessionId },
    include: {
      holds: { where: { status: "active" }, select: { id: true, calendarEventId: true } },
      link: { select: { inviteeName: true } },
    },
  });
  if (!negotiation) return { success: false, reason: "session_not_found" };
  if (negotiation.status !== "agreed") {
    return { success: false, reason: "not_in_agreed_state" };
  }

  let calendarEventCleared = false;
  if (negotiation.calendarEventId) {
    try {
      await deleteCalendarEvent(negotiation.hostId, negotiation.calendarEventId, {
        notifyAttendees: true,
      });
      calendarEventCleared = true;
    } catch (e) {
      console.error("[session-state] failed to delete confirmed calendar event:", e);
      // Non-blocking — proceed with DB cleanup regardless. Same behavior as
      // the legacy route at line 56-58.
    }
  }

  if (negotiation.holds.length > 0) {
    await Promise.all(
      negotiation.holds.map(async (hold) => {
        if (hold.calendarEventId) {
          try {
            await deleteCalendarEvent(negotiation.hostId, hold.calendarEventId);
          } catch (e) {
            console.warn(`[session-state] failed to delete hold event ${hold.calendarEventId}:`, e);
          }
        }
      }),
    );
    await prisma.hold.updateMany({
      where: { sessionId: input.sessionId, status: "active" },
      data: { status: "released" },
    });
  }

  try {
    await invalidateSchedule(negotiation.hostId);
  } catch (e) {
    console.warn("[session-state] schedule cache invalidation failed (non-blocking):", e);
  }

  const statusLabel =
    input.initiator === "host"
      ? "Rescheduling — finding a new time"
      : negotiation.link.inviteeName
      ? `Rescheduling — ${negotiation.link.inviteeName} finding a new time`
      : "Rescheduling — guest finding a new time";

  await prisma.negotiationSession.update({
    where: { id: input.sessionId },
    data: {
      status: "active",
      archived: false,
      statusLabel,
      agreedTime: null,
      agreedFormat: null,
      meetLink: null,
      calendarEventId: null,
    },
  });

  const systemContent =
    input.initiator === "host"
      ? "The host has requested to reschedule this meeting. The previous time has been cancelled and attendees have been notified. A new time is being arranged."
      : "The guest has requested to reschedule this meeting. The previous time has been cancelled and attendees have been notified. A new time is being arranged.";

  await prisma.message.create({
    data: {
      sessionId: input.sessionId,
      role: "system",
      content: systemContent,
    },
  });

  return { success: true, calendarEventCleared };
}
