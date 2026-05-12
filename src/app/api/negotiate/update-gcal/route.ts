import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logRouteError } from "@/lib/route-error";
import { updateConfirmedMeeting } from "@/lib/update-confirmed-meeting";
import type { RefusalReason } from "@/lib/update-confirmed-meeting";

// POST /api/negotiate/update-gcal
//
// Thin wrapper over `updateConfirmedMeeting` (PR-A of the 2026-05-11
// refactor). The helper owns resolution + GCal patch + DB writes + thread
// system message + actor metadata. This route's job is body parsing,
// refusal-to-HTTP mapping, and 500-shim for unexpected throws.
//
// Auth: sessionId-only — same model as /api/negotiate/reschedule,
// /confirm, /message. Anyone holding the deal-room URL can patch. GCal
// API calls inside the helper run against session.hostId's credentials.
// Body's optional `actor` lets the client annotate viewer role; if absent,
// invoker defaults to "guest" (conservative — host-clicked picker passes
// `{ invoker: "host" }` explicitly).

const bodySchema = z.object({
  sessionId: z.string().min(1),
  proposed: z.object({
    // Accept `null` for explicit-clear, matching MeetingChanges shape.
    location: z.string().nullable().optional(),
    format: z.enum(["phone", "video", "in-person"]).optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    duration: z.number().int().positive().optional(),
  }),
  notifyAttendees: z.boolean().default(false),
  actor: z
    .object({
      invoker: z.enum(["host", "guest", "agent", "system"]),
      triggeringRole: z.enum(["host", "guest"]).optional(),
    })
    .optional(),
});

const REFUSAL_TO_STATUS: Record<RefusalReason, number> = {
  session_not_found: 404,
  session_not_agreed: 409,
  session_archived: 409,
  no_calendar_event: 400,
  past_start_time: 400,
  ownership_mismatch: 403,
  gcal_failed: 502,
  invalid_format: 400,
  group_session_not_supported: 400,
};

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { sessionId, proposed, notifyAttendees, actor } = parsed.data;

    // MeetingChanges shape: pass through what the body carried. Helper
    // applies partial-state semantics — absent keys preserve current value.
    const changes: Parameters<typeof updateConfirmedMeeting>[1] = {};
    if ("location" in proposed) changes.location = proposed.location ?? null;
    if (proposed.format !== undefined) changes.format = proposed.format;
    if (proposed.startTime !== undefined) {
      changes.startTime = new Date(proposed.startTime);
    }
    if (proposed.endTime !== undefined) {
      changes.endTime = new Date(proposed.endTime);
    }
    if (proposed.duration !== undefined) changes.duration = proposed.duration;

    const result = await updateConfirmedMeeting(sessionId, changes, {
      actor: actor ?? { invoker: "guest" },
      notifyAttendees,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: REFUSAL_TO_STATUS[result.reason] ?? 400 },
      );
    }

    return NextResponse.json({
      success: true,
      eventId: result.gcalEventId,
      htmlLink: result.gcalHtmlLink,
    });
  } catch (err) {
    logRouteError({
      route: "/api/negotiate/update-gcal",
      method: "POST",
      statusCode: 500,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
