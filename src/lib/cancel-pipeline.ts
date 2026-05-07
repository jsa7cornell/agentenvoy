/**
 * Shared cancel-pipeline: the one mechanical cascade that runs when a
 * NegotiationSession gets cancelled, regardless of who initiated it.
 *
 * History: `/api/negotiate/cancel` (HTTP / host-UI) and `handleCancel`
 * (agent action) diverged over time. The HTTP route deleted the Google
 * event + released holds + invalidated schedule cache; the agent action
 * only flipped DB state. This meant agent-triggered cancels left live
 * Google events and active holds in place — a latent correctness bug.
 *
 * This module centralizes the cascade so every caller gets the same
 * behavior. Callers are responsible for their own authorization / state
 * pre-checks (e.g. "is this session in a cancellable state"); this
 * function is the mechanical cascade only.
 *
 * Per 2026-04-20 decision (calendar-popup-cancel-reschedule-ctas proposal
 * §Q4): cancelled sessions are NOT archived — they stay accessible in the
 * feed with a cancelled label. Users can archive manually.
 *
 * Per 2026-04-20 decision (§Q3): we pass sendUpdates:"all" by default, so
 * Google sends its native cancellation email to attendees. No Envoy email
 * layered on top (deferred to wishlist).
 */

import { prisma } from "@/lib/prisma";
import { deleteCalendarEvent, invalidateSchedule } from "@/lib/calendar";

export type CancelInitiator = "host" | "guest" | "external" | "agent";

export interface CancelSessionInput {
  sessionId: string;
  /** The host's userId — authorization check + used to scope Google API calls. */
  hostId: string;
  /** Who initiated the cancellation. Drives the statusLabel + system message. */
  initiator: CancelInitiator;
  /** Display name of the initiator (first name). Used in the timeline indicator. */
  initiatorName?: string | null;
  /** Optional freeform note. Appended to the system message in the deal room. */
  note?: string | null;
  /** Whether Google's cancellation email should be sent to attendees.
   *  Default true (matches prior `/api/negotiate/cancel` behavior).
   *  Drift-cancel passes false — Google already sent its email when the host
   *  deleted the event directly. */
  notifyAttendees?: boolean;
}

export interface CancelSessionResult {
  ok: boolean;
  /** True on success. False if session wasn't found, unauthorized, or errored. */
  error?: string;
  /** False if session was already cancelled (no-op). */
  changed?: boolean;
}

/**
 * Run the full cancel cascade on a session. Idempotent for already-cancelled
 * sessions (returns ok:true, changed:false).
 *
 * Callers should do their own business-rule gating BEFORE calling this — e.g.
 * the HTTP route only allows cancel from `agreed` state. This primitive
 * accepts any state and just runs the cascade.
 */
export async function cancelSession(
  input: CancelSessionInput
): Promise<CancelSessionResult> {
  const { sessionId, hostId, initiator, initiatorName, note, notifyAttendees = true } = input;

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      holds: {
        where: { status: "active" },
        select: { id: true, calendarEventId: true },
      },
      link: { select: { inviteeName: true } },
    },
  });

  if (!session) return { ok: false, error: "Session not found" };
  if (session.hostId !== hostId) return { ok: false, error: "Unauthorized" };
  if (session.status === "cancelled") return { ok: true, changed: false };

  // 1. Delete the confirmed Google Calendar event (notifying attendees unless
  //    caller opted out). Non-blocking: proceed with DB cleanup even if the
  //    Google API call fails, so we don't leave stuck DB state when Google is
  //    flaky.
  if (session.calendarEventId) {
    try {
      await deleteCalendarEvent(hostId, session.calendarEventId, {
        notifyAttendees,
      });
    } catch (e) {
      console.error(
        `[cancelSession] failed to delete calendar event (session=${sessionId}):`,
        e
      );
    }
  }

  // 1b. Delete the buffer event if one exists. Non-blocking.
  if (session.bufferCalendarEventId) {
    try {
      await deleteCalendarEvent(hostId, session.bufferCalendarEventId);
    } catch (e) {
      console.warn(
        `[cancelSession] failed to delete buffer event ${session.bufferCalendarEventId}:`,
        e
      );
    }
  }

  // 2. Release any active holds (tentative calendar events).
  if (session.holds.length > 0) {
    await Promise.all(
      session.holds.map(async (hold) => {
        if (hold.calendarEventId) {
          try {
            await deleteCalendarEvent(hostId, hold.calendarEventId);
          } catch (e) {
            console.warn(
              `[cancelSession] failed to delete hold event ${hold.calendarEventId}:`,
              e
            );
          }
        }
      })
    );
    await prisma.hold.updateMany({
      where: { sessionId, status: "active" },
      data: { status: "released" },
    });
  }

  // 3. Invalidate schedule cache so the slot re-opens.
  try {
    await invalidateSchedule(hostId);
  } catch (e) {
    console.warn(
      "[cancelSession] schedule cache invalidation failed (non-blocking):",
      e
    );
  }

  // 4. Flip session state. NOT archived — cancelled sessions stay visible in
  //    the feed with their cancelled label per Q4.
  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: {
      status: "cancelled",
      statusLabel: statusLabelFor(initiator, session.link.inviteeName),
      cancelledAt: new Date(),
      cancelledByRole: initiator,
      cancellationNote: note?.trim() || null,
    },
  });

  // 5. Post system timeline indicator in the deal room.
  await prisma.message.create({
    data: {
      sessionId,
      role: "system",
      content: cancelIndicatorFor(initiator, initiatorName),
      metadata: { kind: "cancel_event" } as unknown as import("@prisma/client").Prisma.InputJsonValue,
    },
  });

  return { ok: true, changed: true };
}

function statusLabelFor(
  initiator: CancelInitiator,
  inviteeName: string | null
): string {
  switch (initiator) {
    case "host":
      return "Cancelled by host";
    case "agent":
      return "Cancelled by host";
    case "guest":
      return inviteeName ? `Cancelled by ${inviteeName}` : "Cancelled by guest";
    case "external":
      return "Cancelled in Google Calendar";
  }
}

function cancelIndicatorFor(
  initiator: CancelInitiator,
  initiatorName: string | null | undefined,
): string {
  const name = initiatorName?.split(/\s+/)[0]?.trim();
  switch (initiator) {
    case "host":
    case "agent":
      return name ? `Meeting cancelled by ${name}` : "Meeting cancelled by host";
    case "guest":
      return name ? `Meeting cancelled by ${name}` : "Meeting cancelled by guest";
    case "external":
      return "Meeting cancelled in Google Calendar";
  }
}
