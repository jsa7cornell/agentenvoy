/**
 * Shared reschedule-pipeline: the mechanical cascade for moving an
 * `agreed` NegotiationSession to a new slot, in-place on Google Calendar.
 *
 * Mirrors the cancel-pipeline.ts shape exactly (signature, structure,
 * non-blocking-on-google-failure precedent for sibling concerns) but
 * BREAKS PARITY in one load-bearing way per the proposal §B1 fold:
 *
 *   When the GCal `events.patch` fails, we **abort** — return
 *   `gcal_patch_failed`, no DB update. The asymmetry vs. cancel is
 *   intentional: a missed-cancel leaves a ghost event (recoverable),
 *   a missed-reschedule sends people to the wrong time (not).
 *
 * Idempotency: callers pass an optional `idempotencyKey`. The pipeline
 * checks `RescheduleAttempt` for a prior matching outcome on the same
 * (sessionId, idempotencyKey) — replay-correct, no double-execute.
 *
 * Proposal: 2026-04-29_mcp-reschedule-meeting-patch-in-place_*_decided-2026-04-30.md
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAgentEnvoyOwnedEvent,
  updateCalendarEvent,
  invalidateSchedule,
  GcalOwnershipError,
} from "@/lib/calendar";

export type RescheduleInitiator = "host" | "guest" | "external" | "agent";

export type RescheduleOutcome =
  | "success"
  | "already_at_target"
  | "session_not_found"
  | "session_not_agreed"
  | "slot_mismatch"
  | "gcal_patch_failed"
  | "validation_failed"
  | "server_error";

export interface RescheduleSessionInput {
  sessionId: string;
  /** The host's userId — authorization check + scopes Google API calls. */
  hostId: string;
  /** New slot start; we derive end from existing duration unless overridden. */
  newSlot: { start: Date; durationMinutes?: number };
  /** Who initiated the reschedule. Drives the timeline indicator. */
  initiator: RescheduleInitiator;
  /** Display name (first name) of the initiator. */
  initiatorName?: string | null;
  /** Optional freeform note appended to the timeline indicator. */
  reason?: string | null;
  /** Whether Google's update notification should fire. Default true. */
  notifyAttendees?: boolean;
  /** Optional format/location overrides applied alongside the slot move. */
  overrides?: { format?: string; location?: string | null };
  /** Caller-supplied idempotency key. Same key + same sessionId returns
   *  the prior `responseBody` verbatim — no double-execution.
   *  Lifetime is the row's lifetime (no 24h TTL). */
  idempotencyKey?: string | null;
}

export type RescheduleSessionResult =
  | {
      ok: true;
      outcome: "success" | "already_at_target";
      changed: boolean;
      fromStart: string;
      toStart: string;
      /** When `changed: false`, this is the prior call's response body. */
      replayedFrom?: "RescheduleAttempt";
    }
  | {
      ok: false;
      outcome: Exclude<RescheduleOutcome, "success" | "already_at_target">;
      error: string;
    };

const ONE_SECOND_MS = 1000;

/**
 * Run the reschedule cascade. Idempotent for already-at-target requests
 * (returns ok:true, changed:false). Idempotent across same-key retries
 * via RescheduleAttempt.
 */
export async function rescheduleSession(
  input: RescheduleSessionInput,
): Promise<RescheduleSessionResult> {
  const startedAt = Date.now();
  const {
    sessionId,
    hostId,
    newSlot,
    initiator,
    initiatorName,
    reason,
    notifyAttendees = true,
    overrides,
    idempotencyKey,
  } = input;

  // 0. Idempotent replay check.
  if (idempotencyKey) {
    const prior = await prisma.rescheduleAttempt.findFirst({
      where: { sessionId, idempotencyKey, outcome: "success" },
      orderBy: { createdAt: "desc" },
      select: { responseBody: true, fromStart: true, toStart: true },
    });
    if (prior?.responseBody) {
      const body = prior.responseBody as Prisma.JsonObject;
      const fromIso = (body.fromStart as string | undefined) ??
        prior.fromStart.toISOString();
      const toIso = (body.toStart as string | undefined) ??
        prior.toStart.toISOString();
      return {
        ok: true,
        outcome: "success",
        changed: false,
        fromStart: fromIso,
        toStart: toIso,
        replayedFrom: "RescheduleAttempt",
      };
    }
  }

  // 1. Load + authorize.
  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      link: { select: { inviteeName: true } },
      holds: {
        where: { status: "active" },
        select: { id: true, calendarEventId: true },
      },
    },
  });

  if (!session) {
    await recordAttempt({
      sessionId,
      idempotencyKey,
      fromStart: new Date(0),
      toStart: newSlot.start,
      outcome: "session_not_found",
      errorMessage: "Session not found",
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, outcome: "session_not_found", error: "Session not found" };
  }
  if (session.hostId !== hostId) {
    return { ok: false, outcome: "session_not_found", error: "Unauthorized" };
  }

  // 2. State guard. Only `agreed` is reschedulable.
  if (session.status !== "agreed") {
    await recordAttempt({
      sessionId,
      idempotencyKey,
      fromStart: session.agreedTime ?? new Date(0),
      toStart: newSlot.start,
      outcome: "session_not_agreed",
      errorMessage: `Status is ${session.status}; only agreed sessions are reschedulable`,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      outcome: "session_not_agreed",
      error: "Only confirmed meetings can be rescheduled",
    };
  }

  if (!session.agreedTime) {
    return { ok: false, outcome: "session_not_agreed", error: "Session has no agreedTime" };
  }
  if (!session.calendarEventId) {
    return {
      ok: false,
      outcome: "session_not_agreed",
      error: "Session has no calendarEventId — nothing to patch",
    };
  }

  const fromStart = session.agreedTime;
  const toStart = newSlot.start;
  const durationMin =
    newSlot.durationMinutes ?? session.duration ?? 30;
  const toEnd = new Date(toStart.getTime() + durationMin * 60_000);

  // 3. Idempotency — already at target slot + matching overrides?
  const sameSlot =
    Math.abs(fromStart.getTime() - toStart.getTime()) < ONE_SECOND_MS;
  const sameFormat =
    !overrides?.format || overrides.format === session.agreedFormat;
  const sameLocation =
    overrides?.location === undefined ||
    overrides.location === (session as { location?: string | null }).location;
  if (sameSlot && sameFormat && sameLocation) {
    return {
      ok: true,
      outcome: "already_at_target",
      changed: false,
      fromStart: fromStart.toISOString(),
      toStart: toStart.toISOString(),
    };
  }

  // 4. GCal patch — BLOCKING on failure (asymmetry vs. cancel-pipeline,
  // proposal §B1 fold). If Google rejects the patch, we abort. No DB
  // change. The asymmetry: a missed-cancel leaves a ghost event
  // (recoverable); a missed-reschedule produces wrong-time attendance
  // (unrecoverable).
  try {
    await assertAgentEnvoyOwnedEvent(hostId, session.calendarEventId, sessionId);
    await updateCalendarEvent(
      hostId,
      session.calendarEventId,
      sessionId,
      {
        startTime: toStart,
        endTime: toEnd,
        ...(overrides?.location !== undefined ? { location: overrides.location } : {}),
      },
      { notifyAttendees },
    );
  } catch (e) {
    const errorMessage =
      e instanceof GcalOwnershipError
        ? `Calendar event ${session.calendarEventId} is not owned by this session`
        : e instanceof Error
          ? e.message
          : String(e);
    console.error(
      `[rescheduleSession] GCal patch failed (session=${sessionId}):`,
      errorMessage,
    );
    await recordAttempt({
      sessionId,
      idempotencyKey,
      fromStart,
      toStart,
      outcome: "gcal_patch_failed",
      errorMessage,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      outcome: "gcal_patch_failed",
      error: "Google Calendar refused the patch (transient). Try again.",
    };
  }

  // 5. Release any active holds (defensive — agreed sessions usually have none).
  if (session.holds.length > 0) {
    await prisma.hold.updateMany({
      where: { sessionId, status: "active" },
      data: { status: "released" },
    });
  }

  // 6. Invalidate schedule cache so the previously-blocked slot reopens.
  try {
    await invalidateSchedule(hostId);
  } catch (e) {
    console.warn(
      "[rescheduleSession] schedule cache invalidation failed (non-blocking):",
      e,
    );
  }

  // 7. DB update — patch-in-place keeps status `agreed`. Append to
  // rescheduleHistory; bump lastRescheduledAt; clear finalizesAt (when
  // the chain pattern lands, this resets the host-objection window).
  const historyEntry = {
    from: fromStart.toISOString(),
    to: toStart.toISOString(),
    at: new Date().toISOString(),
    by: initiator,
    ...(initiatorName ? { byName: initiatorName } : {}),
    ...(reason ? { reason } : {}),
  };
  const existingHistory =
    (session.rescheduleHistory as Prisma.JsonArray | null) ?? [];
  const newHistory = [...existingHistory, historyEntry] as Prisma.InputJsonValue;

  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: {
      agreedTime: toStart,
      ...(overrides?.format ? { agreedFormat: overrides.format } : {}),
      ...(overrides?.location !== undefined ? { location: overrides.location } : {}),
      duration: durationMin,
      rescheduleHistory: newHistory,
      lastRescheduledAt: new Date(),
      finalizesAt: null,
    },
  });

  // 8. Post system timeline indicator.
  await prisma.message.create({
    data: {
      sessionId,
      role: "system",
      content: rescheduleIndicatorFor(initiator, initiatorName, fromStart, toStart),
      metadata: {
        kind: "reschedule_event",
        from: fromStart.toISOString(),
        to: toStart.toISOString(),
        initiator,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // 9. Record successful attempt for idempotent replay.
  const responseBody: Prisma.InputJsonValue = {
    ok: true,
    fromStart: fromStart.toISOString(),
    toStart: toStart.toISOString(),
    initiator,
  };
  await recordAttempt({
    sessionId,
    idempotencyKey,
    fromStart,
    toStart,
    outcome: "success",
    responseBody,
    durationMs: Date.now() - startedAt,
  });

  return {
    ok: true,
    outcome: "success",
    changed: true,
    fromStart: fromStart.toISOString(),
    toStart: toStart.toISOString(),
  };
}

async function recordAttempt(args: {
  sessionId: string;
  idempotencyKey?: string | null;
  fromStart: Date;
  toStart: Date;
  outcome: RescheduleOutcome;
  responseBody?: Prisma.InputJsonValue;
  errorMessage?: string;
  durationMs: number;
}): Promise<void> {
  try {
    await prisma.rescheduleAttempt.create({
      data: {
        sessionId: args.sessionId,
        idempotencyKey: args.idempotencyKey ?? null,
        fromStart: args.fromStart,
        toStart: args.toStart,
        outcome: args.outcome,
        responseBody: args.responseBody ?? Prisma.JsonNull,
        errorMessage: args.errorMessage ?? null,
        durationMs: args.durationMs,
      },
    });
  } catch (e) {
    // Non-fatal — losing an audit row shouldn't break the operation itself.
    console.error("[rescheduleSession] RescheduleAttempt write failed:", e);
  }
}

/**
 * Build the timeline indicator string. Mirrors `cancelIndicatorFor` from
 * cancel-pipeline.ts.
 */
function rescheduleIndicatorFor(
  initiator: RescheduleInitiator,
  initiatorName: string | null | undefined,
  from: Date,
  to: Date,
): string {
  const name = initiatorName?.split(/\s+/)[0]?.trim();
  const fromStr = from.toISOString();
  const toStr = to.toISOString();
  switch (initiator) {
    case "host":
    case "agent":
      return name
        ? `Meeting moved by ${name} from ${fromStr} to ${toStr}`
        : `Meeting moved by host from ${fromStr} to ${toStr}`;
    case "guest":
      return name
        ? `Meeting moved by ${name} from ${fromStr} to ${toStr}`
        : `Meeting moved by guest from ${fromStr} to ${toStr}`;
    case "external":
      return `Meeting moved in Google Calendar from ${fromStr} to ${toStr}`;
  }
}
