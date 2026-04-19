import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { confirmBooking, type ConfirmResult } from "@/lib/confirm-pipeline";
import { logRouteError } from "@/lib/route-error";

// POST /api/negotiate/confirm
// Thin HTTP wrapper over `confirmBooking` in `src/lib/confirm-pipeline.ts`.
// See proposal 2026-04-19_confirm-pipeline-extraction for the split.
//
// Reliability invariants (2026-04-16, carried over into the pipeline):
//   1. Every call writes exactly one ConfirmAttempt row regardless of outcome.
//      (Written in `finally` below using the `attempt` record the pipeline
//      returns on both branches.)
//   2. Session status transition `active → agreed` uses a compare-and-swap
//      in `confirmBooking` — concurrent confirms can't both succeed.
//   3. Independent post-GCal work runs in parallel inside the pipeline.
//
// See: agentenvoy/app/src/app/admin/failures/page.tsx
const REASON_TO_STATUS: Record<Extract<ConfirmResult, { ok: false }>["reason"], number> = {
  validation_failed: 400,
  session_not_found: 404,
  host_email_missing: 400,
  in_person_disallowed: 409,
  slot_mismatch: 409,
};

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 200) || null;

  // Pipeline's `attempt` record drives the ConfirmAttempt write below.
  // Initialized to a safe default so an early JSON-parse throw still records.
  let attempt: ConfirmResult["attempt"] = {
    outcome: "server_error",
    error: null,
    sessionId: null,
    slotStart: null,
    slotEnd: null,
  };

  try {
    const body = await req.json();
    const result = await confirmBooking({
      sessionId: body.sessionId,
      dateTime: body.dateTime,
      duration: body.duration,
      format: body.format,
      location: body.location,
      guestEmail: body.guestEmail,
      guestName: body.guestName,
      wantsReminder: body.wantsReminder,
      guestNote: body.guestNote,
      userAgent,
    });
    attempt = result.attempt;

    if (result.ok) {
      return NextResponse.json({
        status: result.status,
        dateTime: result.dateTime,
        duration: result.duration,
        format: result.format,
        location: result.location,
        meetLink: result.meetLink,
        eventLink: result.eventLink,
        emailSent: result.emailSent,
        ...(result.idempotent ? { idempotent: true } : {}),
      });
    }

    return NextResponse.json(
      { error: result.message },
      { status: REASON_TO_STATUS[result.reason] }
    );
  } catch (e) {
    // Top-level unexpected error — persist to RouteError so it surfaces on
    // /admin/failures alongside the ConfirmAttempt record.
    attempt = {
      ...attempt,
      outcome: "server_error",
      error: e instanceof Error ? e.message : String(e),
    };
    logRouteError({
      route: "/api/negotiate/confirm",
      method: "POST",
      statusCode: 500,
      error: e,
      context: { sessionId: attempt.sessionId ?? undefined },
      userAgent,
    });
    console.error("[confirm] unhandled error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  } finally {
    // Fire-and-forget ConfirmAttempt write. Deliberately not awaited — we
    // don't want to delay the response, and we don't want a DB hiccup to
    // convert a successful confirm into a client error.
    const durationMs = Date.now() - t0;
    prisma.confirmAttempt
      .create({
        data: {
          sessionId: attempt.sessionId,
          slotStart: attempt.slotStart,
          slotEnd: attempt.slotEnd,
          outcome: attempt.outcome,
          errorMessage: attempt.error,
          userAgent,
          durationMs,
        },
      })
      .catch((dbErr) => {
        console.error("[confirm] Failed to persist ConfirmAttempt:", dbErr);
      });
  }
}

// PATCH /api/negotiate/confirm
// Update feedback on a NegotiationOutcome
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { sessionId, feedback } = body;

  if (!sessionId || !feedback) {
    return NextResponse.json(
      { error: "Missing sessionId or feedback" },
      { status: 400 }
    );
  }

  try {
    await prisma.negotiationOutcome.update({
      where: { sessionId },
      data: { feedback },
    });
    return NextResponse.json({ status: "updated" });
  } catch {
    return NextResponse.json(
      { error: "Outcome not found" },
      { status: 404 }
    );
  }
}
