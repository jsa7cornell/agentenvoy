import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createCalendarEvent, deleteCalendarEvent, invalidateSchedule } from "@/lib/calendar";
import { extractLearnings } from "@/agent/administrator";
import { getUserTimezone } from "@/lib/timezone";
import { dispatch } from "@/lib/side-effects/dispatcher";
import { logRouteError } from "@/lib/route-error";
import { buildGuestConfirmationEmail } from "@/lib/emails/guest-confirmation";

// POST /api/negotiate/confirm
// Confirm an agreed-upon time — creates calendar events, sends emails.
//
// Reliability invariants (2026-04-16):
//   1. Every call writes exactly one ConfirmAttempt row regardless of outcome.
//   2. Session status transition `active → agreed` uses a compare-and-swap
//      (`updateMany where status != 'agreed'`) so concurrent confirms can't
//      both succeed. Loser returns winner's data (same slot) or 409 (different).
//   3. Independent post-GCal work runs in parallel. Only `extractLearnings`
//      (slow Claude call) is deferred to `waitUntil` — everything user-visible
//      stays in the critical path.
//
// See: agentenvoy/app/src/app/admin/failures/page.tsx
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 200) || null;

  // Attempt-tracking state — written to ConfirmAttempt in `finally`.
  let attemptOutcome:
    | "success"
    | "already_agreed"
    | "slot_mismatch"
    | "gcal_failed"
    | "server_error"
    | "validation_failed" = "server_error";
  let attemptError: string | null = null;
  let attemptSessionId: string | null = null;
  let attemptSlotStart: Date | null = null;
  let attemptSlotEnd: Date | null = null;

  try {
    const body = await req.json();
    // NOTE: `timezone` from the request body is ignored. The host's timezone
    // is canonical and comes from stored preferences. LLMs must not be trusted
    // to emit IANA strings.
    const {
      sessionId,
      dateTime,
      duration,
      format,
      location,
      guestEmail: bodyGuestEmail,
      guestName: bodyGuestName,
      wantsReminder: bodyWantsReminder,
      guestNote: bodyGuestNote,
    } = body;

    if (!sessionId || !dateTime) {
      attemptOutcome = "validation_failed";
      attemptError = "Missing sessionId or dateTime";
      return NextResponse.json(
        { error: "Missing sessionId or dateTime" },
        { status: 400 }
      );
    }
    attemptSessionId = sessionId;

    const session = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      include: { link: true, host: true },
    });

    if (!session) {
      attemptOutcome = "validation_failed";
      attemptError = "Session not found";
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Host's timezone is canonical — read from stored preferences, never from the body.
    const hostPrefs = session.host.preferences as Record<string, unknown> | null;
    const hostTimezone = getUserTimezone(hostPrefs);

    // Parse + DST-correct dateTime → startTime.
    let dateTimeStr = dateTime as string;
    const hasOffset = /[+-]\d{2}:\d{2}$/.test(dateTimeStr) || dateTimeStr.endsWith("Z");
    if (!hasOffset) {
      const roughOffset = computeUtcOffset(hostTimezone);
      const roughDate = new Date(`${dateTimeStr}${roughOffset}`);
      const dstCorrectOffset = computeUtcOffset(hostTimezone, roughDate);
      dateTimeStr = `${dateTimeStr}${dstCorrectOffset}`;
    } else {
      const embeddedDate = new Date(dateTimeStr);
      const correctOffset = computeUtcOffset(hostTimezone, embeddedDate);
      const embeddedOffsetMatch = dateTimeStr.match(/([+-]\d{2}:\d{2})$/);
      const embeddedOffset = embeddedOffsetMatch?.[1];
      if (embeddedOffset && embeddedOffset !== correctOffset) {
        const bare = dateTimeStr.slice(0, dateTimeStr.length - embeddedOffset.length);
        dateTimeStr = `${bare}${correctOffset}`;
        console.log(
          `[confirm] DST offset corrected: ${embeddedOffset} → ${correctOffset} for "${bare}" (${hostTimezone})`
        );
      }
    }

    const startTime = new Date(dateTimeStr);
    const durationMin = duration || 30;
    const endTime = new Date(startTime.getTime() + durationMin * 60 * 1000);
    const meetingFormat = format || "video";
    attemptSlotStart = startTime;
    attemptSlotEnd = endTime;

    // === Idempotency: handle already-agreed sessions ===
    // Belt (pre-check): cheap short-circuit if we already know the answer.
    // Suspenders (CAS below): atomic at the DB even if this pre-check races.
    if (session.status === "agreed") {
      const slotMatches =
        session.agreedTime &&
        Math.abs(session.agreedTime.getTime() - startTime.getTime()) < 60_000;
      if (slotMatches) {
        attemptOutcome = "already_agreed";
        return NextResponse.json({
          status: "confirmed",
          dateTime: session.agreedTime!.toISOString(),
          duration: durationMin,
          format: session.agreedFormat ?? meetingFormat,
          location: location || null,
          meetLink: session.meetLink ?? undefined,
          eventLink: undefined,
          emailSent: false,
          idempotent: true,
        });
      }
      attemptOutcome = "slot_mismatch";
      attemptError = `Session already agreed at ${session.agreedTime?.toISOString()}, requested ${startTime.toISOString()}`;
      return NextResponse.json(
        { error: "Session already confirmed for a different slot" },
        { status: 409 }
      );
    }

    const hostEmail = session.host.email;
    if (!hostEmail) {
      attemptOutcome = "validation_failed";
      attemptError = "Host email not found";
      return NextResponse.json({ error: "Host email not found" }, { status: 400 });
    }

    // Group event resolution
    const isGroupEvent = session.link.mode === "group";
    let allParticipantEmails: string[] = [];
    let allParticipantSessions: string[] = [];
    if (isGroupEvent) {
      const participants = await prisma.sessionParticipant.findMany({
        where: { linkId: session.linkId },
      });
      allParticipantEmails = participants
        .map((p) => p.email)
        .filter((e): e is string => !!e);
      allParticipantSessions = participants.map((p) => p.sessionId);
    }

    // Body-provided guest info (from the confirm card) takes precedence so
    // guests can correct what Envoy captured earlier in conversation.
    const bodyGuestEmailStr = typeof bodyGuestEmail === "string" && bodyGuestEmail.trim()
      ? bodyGuestEmail.trim()
      : null;
    const bodyGuestNameStr = typeof bodyGuestName === "string" && bodyGuestName.trim()
      ? bodyGuestName.trim()
      : null;
    const guestEmail =
      bodyGuestEmailStr ||
      session.guestEmail ||
      session.link.inviteeEmail ||
      null;
    const guestName =
      bodyGuestNameStr ||
      session.guestName ||
      session.link.inviteeName ||
      null;
    if (!guestEmail) {
      console.warn(
        `[confirm] sessionId=${sessionId} — no guest email; calendar invite will only have host.`
      );
    }
    const attendeeEmails = isGroupEvent
      ? [hostEmail, ...allParticipantEmails.filter((e) => e !== hostEmail)]
      : [hostEmail, ...(guestEmail ? [guestEmail] : [])];

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://agentenvoy.ai";
    const dealRoomUrl = session.link.code
      ? `${baseUrl}/meet/${session.link.slug}/${session.link.code}`
      : `${baseUrl}/meet/${session.link.slug}`;

    const hostPhone = (hostPrefs?.phone as string) || null;
    const videoProvider = (hostPrefs?.videoProvider as string) || "google-meet";
    const zoomLink = (hostPrefs?.zoomLink as string) || null;

    const guestLabel = guestName || guestEmail || "guest";
    const hostLabel = session.host.name || "Host";
    const eventSummary = (() => {
      if (session.link.topic) return `${session.link.topic} — ${guestLabel}`;
      if (meetingFormat === "phone") return `Phone call: ${guestLabel} & ${hostLabel}`;
      return `Meeting with ${guestLabel}`;
    })();

    const linkRulesObj = (session.link?.rules as Record<string, unknown> | null) || {};
    const linkLocation =
      typeof linkRulesObj.location === "string" && linkRulesObj.location.trim()
        ? linkRulesObj.location.trim()
        : null;
    const effectiveLocation =
      location ||
      linkLocation ||
      (meetingFormat === "phone" && hostPhone
        ? `${guestLabel} calls ${session.host.name || "host"} @ ${hostPhone}`
        : null) ||
      (meetingFormat === "video" && videoProvider === "zoom" && zoomLink
        ? zoomLink
        : null);

    // === Compare-and-swap: claim the slot ===
    // Only one concurrent request can flip status `active → agreed`. The
    // loser returns `already_agreed` (same slot) or 409 (different) above
    // on its own next read. Combined with the pre-check, this is our
    // belt-and-suspenders against double-confirm races.
    const sessionIdsToUpdate = isGroupEvent ? allParticipantSessions : [sessionId];
    const confirmSummaryPlaceholder = `${meetingFormat} meeting${effectiveLocation ? ` — ${effectiveLocation}` : ""}`;
    const casResult = await prisma.negotiationSession.updateMany({
      where: { id: { in: sessionIdsToUpdate }, status: { not: "agreed" } },
      data: {
        status: "agreed",
        statusLabel: null,
        agreedTime: startTime,
        agreedFormat: meetingFormat,
        summary: confirmSummaryPlaceholder,
        ...(bodyGuestNameStr ? { guestName: bodyGuestNameStr } : {}),
        ...(bodyGuestEmailStr ? { guestEmail: bodyGuestEmailStr } : {}),
        ...(typeof bodyWantsReminder === "boolean" ? { wantsReminder: bodyWantsReminder } : {}),
      },
    });

    if (casResult.count === 0) {
      // Someone else won. Reload and return their data (idempotent success)
      // or 409 if it's a different slot.
      const winner = await prisma.negotiationSession.findUnique({
        where: { id: sessionId },
      });
      if (
        winner?.agreedTime &&
        Math.abs(winner.agreedTime.getTime() - startTime.getTime()) < 60_000
      ) {
        attemptOutcome = "already_agreed";
        return NextResponse.json({
          status: "confirmed",
          dateTime: winner.agreedTime.toISOString(),
          duration: durationMin,
          format: winner.agreedFormat ?? meetingFormat,
          location: effectiveLocation || location || null,
          meetLink: winner.meetLink ?? undefined,
          eventLink: undefined,
          emailSent: false,
          idempotent: true,
        });
      }
      attemptOutcome = "slot_mismatch";
      attemptError = "Concurrent confirm landed on a different slot";
      return NextResponse.json(
        { error: "Session already confirmed for a different slot" },
        { status: 409 }
      );
    }

    // We won the CAS. Proceed with GCal + post-work.

    // Create calendar event for the host
    let meetLink: string | undefined;
    let eventLink: string | undefined;
    let confirmedCalendarEventId: string | undefined;

    const guestNoteStr = typeof bodyGuestNote === "string" && bodyGuestNote.trim()
      ? bodyGuestNote.trim().slice(0, 500)
      : null;

    const tGcalStart = Date.now();
    try {
      const descriptionLines = [
        `Scheduled via AgentEnvoy`,
        `Format: ${meetingFormat}`,
        ...(effectiveLocation ? [`Location: ${effectiveLocation}`] : []),
        ...(isGroupEvent ? [`Participants: ${attendeeEmails.length}`] : []),
        ...(guestNoteStr ? ["", `Note from ${guestName || "guest"}:`, guestNoteStr] : []),
        "",
        `Need to change or cancel? ${dealRoomUrl}`,
      ];
      const useGoogleMeet = meetingFormat === "video" && videoProvider !== "zoom";
      const useZoom = meetingFormat === "video" && videoProvider === "zoom" && !!zoomLink;

      const result = await createCalendarEvent(session.hostId, {
        summary: eventSummary,
        description: descriptionLines.join("\n"),
        startTime,
        endTime,
        attendeeEmails,
        addMeetLink: useGoogleMeet,
        sessionId: session.id,
      });

      if (useZoom) {
        meetLink = zoomLink!;
      } else {
        meetLink = result.meetLink || undefined;
      }
      eventLink = result.htmlLink || undefined;
      confirmedCalendarEventId = result.eventId || undefined;

      // Guard: in production, a synthetic (dryrun/log) or missing event ID
      // means `EFFECT_MODE_CALENDAR` isn't set to `live`. The session UI will
      // show "confirmed" but no real GCal event exists. Surface loudly via
      // /admin/failures so config drift can't silently break bookings.
      const isSynthetic =
        !confirmedCalendarEventId || confirmedCalendarEventId.startsWith("dryrun-");
      if (isSynthetic && process.env.NODE_ENV === "production") {
        attemptOutcome = "gcal_failed";
        attemptError = `Calendar effect returned no real eventId (got ${confirmedCalendarEventId ?? "null"}). Check EFFECT_MODE_CALENDAR=live in Vercel env.`;
        logRouteError({
          route: "/api/negotiate/confirm",
          method: "POST",
          statusCode: 200,
          error: new Error(attemptError),
          context: { sessionId, eventId: confirmedCalendarEventId ?? null },
          userAgent,
        });
        console.error(`[confirm] ${attemptError}`);
      }
    } catch (e) {
      console.error("[confirm] Failed to create calendar event:", e);
      // Continue — calendar is not strictly required. We still mark the
      // attempt as gcal_failed so it surfaces on the admin page for triage.
      attemptOutcome = "gcal_failed";
      attemptError = e instanceof Error ? e.message : String(e);
    }
    const tGcalMs = Date.now() - tGcalStart;

    // === Parallelize independent post-GCal work ===
    // All of these are safe to run concurrently — none depend on each other.
    const tParStart = Date.now();

    const displayDate = startTime.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: hostTimezone,
    });
    const displayTime = startTime.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: hostTimezone,
    });
    const tzAbbr =
      new Intl.DateTimeFormat("en-US", {
        timeZoneName: "short",
        timeZone: hostTimezone,
      })
        .formatToParts(startTime)
        .find((p) => p.type === "timeZoneName")?.value ?? hostTimezone;
    const confirmSummary = `${meetingFormat} meeting on ${displayDate} at ${displayTime} ${tzAbbr}${effectiveLocation ? ` — ${effectiveLocation}` : ""}`;

    // Task A: finalize session row with calendar data + real summary
    const taskFinalizeSession = prisma.negotiationSession.updateMany({
      where: { id: { in: sessionIdsToUpdate } },
      data: {
        meetLink: meetLink || null,
        calendarEventId: confirmedCalendarEventId || null,
        summary: confirmSummary,
      },
    });

    // Task B: invalidate schedule cache (non-blocking failure)
    const taskInvalidate = invalidateSchedule(session.hostId).catch((e) => {
      console.warn("[confirm] schedule cache invalidation failed (non-blocking):", e);
    });

    // Task C: hold cleanup — promote tentative to confirmed.
    // Returns whether this was a stretch booking so we can notify.
    const taskHoldCleanup: Promise<{ hadStretch: boolean }> = (async () => {
      try {
        const activeHolds = await prisma.hold.findMany({
          where: { sessionId, status: "active" },
          select: { id: true, calendarEventId: true },
        });
        if (activeHolds.length === 0) return { hadStretch: false };
        await Promise.all(
          activeHolds.map(async (h) => {
            if (!h.calendarEventId) return;
            try {
              await deleteCalendarEvent(session.hostId, h.calendarEventId);
            } catch (e) {
              console.warn(
                `[confirm] could not delete tentative hold event ${h.calendarEventId}:`,
                e
              );
            }
          })
        );
        await prisma.hold.updateMany({
          where: { sessionId, status: "active" },
          data: { status: "satisfied" },
        });
        return { hadStretch: true };
      } catch (e) {
        console.error("[confirm] hold satisfaction cleanup failed:", e);
        return { hadStretch: false };
      }
    })();

    // Task D: fetch messages once — shared by outcome + learnings.
    // (Previously this was two identical queries.)
    const taskMessages = prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });

    // Task E: participant status sync (group only)
    const taskParticipants = isGroupEvent
      ? prisma.sessionParticipant.updateMany({
          where: { linkId: session.linkId },
          data: { status: "agreed" },
        })
      : Promise.resolve(null);

    const [, , holdResult, allMessages] = await Promise.all([
      taskFinalizeSession,
      taskInvalidate,
      taskHoldCleanup,
      taskMessages,
      taskParticipants,
    ]);
    const tParMs = Date.now() - tParStart;

    // NegotiationOutcome write (uses allMessages from above — no re-query)
    try {
      const guestMessages = allMessages.filter((m) => m.role === "guest");
      const hasCounterProposal = guestMessages.some((m) =>
        /none of|don't work|doesn't work|how about|instead|different/i.test(m.content)
      );
      const timeToConfirmationSec = Math.round(
        (Date.now() - session.createdAt.getTime()) / 1000
      );
      await prisma.negotiationOutcome.create({
        data: {
          sessionId,
          exchangeCount: guestMessages.length,
          tierReached: 1,
          guestCounterProposed: hasCounterProposal,
          timeToConfirmationSec,
          proposedFormat: session.format || null,
          agreedFormat: meetingFormat,
          participantCount: isGroupEvent ? attendeeEmails.length : 2,
        },
      });
    } catch (e) {
      console.error("[confirm] Failed to create NegotiationOutcome:", e);
    }

    // Stretch booking notification (only when the hold cleanup found one)
    if (holdResult.hadStretch) {
      try {
        let channel = await prisma.channel.findUnique({
          where: { userId: session.hostId },
        });
        if (!channel) {
          channel = await prisma.channel.create({ data: { userId: session.hostId } });
        }
        const gl = session.link.inviteeName || guestEmail || "the guest";
        const stretchNote =
          `Stretch slot confirmed for ${gl}: ${displayDate} at ${displayTime} ${tzAbbr}. ` +
          `This was a VIP hold you approved earlier — the guest accepted and it's now on your calendar.`;
        await prisma.channelMessage.create({
          data: {
            channelId: channel.id,
            role: "envoy",
            content: stretchNote,
            threadId: sessionId,
          },
        });
      } catch (e) {
        console.error("[confirm] stretch booking channel notification failed:", e);
      }
    }

    // === Defer learnings extraction ===
    // extractLearnings is a Claude API call (2-4s). Don't block the response
    // on it — the learnings are advisory and the user is waiting.
    waitUntil(
      (async () => {
        try {
          const transcript = allMessages
            .map((m) => `[${m.role}]: ${m.content}`)
            .join("\n");
          const updates = await extractLearnings(
            transcript,
            session.host.persistentKnowledge,
            session.host.upcomingSchedulePreferences,
            session.host.name || "host"
          );
          await prisma.user.update({
            where: { id: session.hostId },
            data: {
              persistentKnowledge: updates.persistent,
              upcomingSchedulePreferences: updates.situational,
            },
          });
        } catch (e) {
          console.error("[confirm] deferred extractLearnings failed:", e);
        }
      })()
    );

    // === Guest-flow onboarding nudge ===
    // When the guest signed in via the deal-room calendar-connect CTA, they
    // skipped the normal onboarding flow. Now that the meeting is locked in,
    // drop a friendly message into the deal-room thread pointing them at
    // the dashboard to finish setup. Email nudge TODO (would live in
    // src/lib/emails/).
    try {
      if (session.guestId && session.guestId !== session.hostId) {
        const guestUser = await prisma.user.findUnique({
          where: { id: session.guestId },
          select: { preferences: true, meetSlug: true, name: true },
        });
        const guestPrefs = (guestUser?.preferences as Record<string, unknown> | null) || {};
        const guestExplicit =
          (guestPrefs.explicit as Record<string, unknown> | undefined) || {};
        const signupSource = guestExplicit.signupSource;
        const nudgeAlreadySent = guestExplicit.guestFlowNudgeSentAt;
        if (signupSource === "guest_flow" && !nudgeAlreadySent && guestUser?.meetSlug) {
          const firstName = guestUser.name?.split(" ")[0] || "there";
          const dashUrl = `${baseUrl}/dashboard`;
          const shareUrl = `${baseUrl}/meet/${guestUser.meetSlug}`;
          await prisma.message.create({
            data: {
              sessionId,
              role: "administrator",
              content:
                `While I've got you — you now have your own AgentEnvoy account, ${firstName}. ` +
                `Your meeting link is ${shareUrl} — anyone can book time with you. ` +
                `Open ${dashUrl} when you have a minute to set your preferences (meeting length, buffers, etc.) and I'll be able to negotiate for you too.`,
              metadata: {
                kind: "guest_flow_nudge",
                meetSlug: guestUser.meetSlug,
              } as unknown as Prisma.InputJsonValue,
            },
          });
          await prisma.user.update({
            where: { id: session.guestId },
            data: {
              preferences: {
                ...guestPrefs,
                explicit: {
                  ...guestExplicit,
                  guestFlowNudgeSentAt: new Date().toISOString(),
                },
              } as Prisma.InputJsonValue,
            },
          });
        }
      }
    } catch (e) {
      console.error("[confirm] guest-flow nudge failed (non-blocking):", e);
    }

    // === Meeting confirmation email — sent to both host and guest ===
    const tEmailStart = Date.now();
    const guestTz = session.guestTimezone || null;

    // Build the recipient list: host always gets it; guest added when known.
    const confirmRecipients = isGroupEvent
      ? attendeeEmails
      : [hostEmail, ...(guestEmail ? [guestEmail] : [])];

    const { subject: confirmSubject, html: confirmHtml } = buildGuestConfirmationEmail({
      hostName: session.host.name || "The organizer",
      guestName: guestName || undefined,
      topic: session.link.topic || undefined,
      dateTime: startTime,
      duration: durationMin,
      format: meetingFormat,
      location: effectiveLocation || undefined,
      meetLink,
      hostTimezone,
      guestTimezone: guestTz,
      dealRoomUrl,
      guestNote: guestNoteStr || undefined,
    });

    let emailSent = false;
    const emailResult = await dispatch({
      kind: "email.send",
      to: confirmRecipients,
      subject: confirmSubject,
      html: confirmHtml,
      context: { sessionId: session.id, hostId: session.hostId, purpose: "meeting_confirmed" },
    });
    emailSent = emailResult.status === "sent";
    if (emailResult.status === "failed") {
      console.error("[confirm] meeting confirmation email failed:", emailResult.error);
    }

    const tEmailMs = Date.now() - tEmailStart;

    const totalMs = Date.now() - t0;
    console.log(
      `[confirm] sessionId=${sessionId} total=${totalMs}ms gcal=${tGcalMs}ms parallel=${tParMs}ms email=${tEmailMs}ms`
    );

    // Only flip outcome to "success" if we didn't already mark gcal_failed.
    if (attemptOutcome !== "gcal_failed") {
      attemptOutcome = "success";
    }

    return NextResponse.json({
      status: "confirmed",
      dateTime: startTime.toISOString(),
      duration: durationMin,
      format: meetingFormat,
      location: effectiveLocation || location || null,
      meetLink,
      eventLink,
      emailSent,
    });
  } catch (e) {
    // Top-level unexpected error — persist to RouteError so it surfaces on
    // /admin/failures alongside the ConfirmAttempt record.
    attemptOutcome = "server_error";
    attemptError = e instanceof Error ? e.message : String(e);
    logRouteError({
      route: "/api/negotiate/confirm",
      method: "POST",
      statusCode: 500,
      error: e,
      context: { sessionId: attemptSessionId ?? undefined },
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
          sessionId: attemptSessionId,
          slotStart: attemptSlotStart,
          slotEnd: attemptSlotEnd,
          outcome: attemptOutcome,
          errorMessage: attemptError,
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

/**
 * Compute the UTC offset string for an IANA timezone at a specific date
 * (e.g., "-07:00" for America/Los_Angeles in PDT, "-08:00" in PST).
 * Pass `date` to get the DST-correct offset for a future meeting time — if
 * omitted, defaults to now (stale for meetings that cross a DST boundary).
 */
function computeUtcOffset(tz: string, date: Date = new Date()): string {
  const now = date;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = offsetPart.match(/GMT([+-]\d{2}:\d{2})/);
  if (match) return match[1];
  if (offsetPart === "GMT") return "+00:00";
  // Fallback
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = now.toLocaleString("en-US", { timeZone: tz });
  const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const diffMin = Math.round(diffMs / 60000);
  const sign = diffMin >= 0 ? "+" : "-";
  const absMin = Math.abs(diffMin);
  const h = String(Math.floor(absMin / 60)).padStart(2, "0");
  const m = String(absMin % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}
