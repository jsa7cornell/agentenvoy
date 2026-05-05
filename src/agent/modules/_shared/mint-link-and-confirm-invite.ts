/**
 * `mintLinkAndConfirmInvite` — shared helper for the "mint link → confirm
 * booking → emit calendar invite" sequence.
 *
 * Background (Path B pre-refactor for bookings → event_action fold,
 * 2026-05-05): both `bookTimeWithCommit` (the deprecated tool) and the
 * forthcoming `create_link({commitMode: "invite"})` action shape need to
 * execute the same sequence:
 *
 *   1. `handleCreateLink(...)` — mint a contextual `/meet/<slug>/<code>` link
 *      and persist a `NegotiationSession`.
 *   2. `confirmBooking({...})` — agree the session at the chosen slot,
 *      send the GCal invite, and embed the meeting URL in the invite
 *      description (`Need to change or cancel? <dealRoomUrl>`, already
 *      stamped by `confirm-pipeline.ts:755`).
 *
 * Extracting the sequence here resolves the mutual-recursion concern:
 * `bookTimeWithCommit` and `handleCreateLink({commitMode: "invite"})` both
 * call this helper rather than calling each other.
 *
 * The helper does NOT own:
 *   - Idempotency lookup (the deprecated `bookTimeWithCommit` tool keeps
 *     its `NegotiationSession.findFirst` short-circuit; `create_link` does
 *     not need it because the action runner enforces a single emission per
 *     turn).
 *   - Input validation (callers shape the inputs).
 *
 * It DOES own:
 *   - Translating `MintAndConfirmInput` into `handleCreateLink` params.
 *   - Calling `confirmBooking` with the resolved session id.
 *   - Resolving the final `meetingUrl` from the persisted link (slug+code).
 *   - Returning a normalized `MintAndConfirmResult` discriminated union.
 */
import { prisma } from "@/lib/prisma";
import { confirmBooking } from "@/lib/confirm-pipeline";
import { handleCreateLink } from "@/agent/actions";

export interface MintAndConfirmInput {
  /** Resolved invitee — must include email; name optional. */
  invitee: {
    email: string;
    name?: string;
  };
  /** Chosen slot. ISO datetimes. */
  slot: {
    start: string;
    end: string;
  };
  /** Meeting intent — passed through to handleCreateLink + confirmBooking. */
  intent: {
    activity?: string;
    durationMinutes?: number;
    format?: "video" | "phone" | "in-person";
    topic?: string;
    hostNote?: string;
    location?: string;
  };
  /** Caller's user id (the host). */
  callerUserId: string;
}

export type MintAndConfirmResult =
  | {
      ok: true;
      sessionId: string;
      meetingUrl: string;
      status: "confirmed";
      dateTime: string;
      duration: number;
      format: string;
      location: string | null;
      emailSent: boolean;
      warnings?: Array<"gcal_failed" | "gcal_skipped_scope">;
      calendarWriteUnavailable?: boolean;
    }
  | {
      ok: false;
      reason:
        | "validation_failed"
        | "session_not_found"
        | "host_email_missing"
        | "in_person_disallowed"
        | "slot_mismatch"
        | "slot_no_longer_offered"
        | "session_already_has_event";
      message: string;
    };

/**
 * Mint a contextual link, then immediately confirm the booking at the
 * chosen slot. The calendar invite description carries the dealRoom URL
 * (stamped inside `confirmBooking`), satisfying the "invite always carries
 * the link" rule for both legacy bookings and forthcoming
 * `create_link({commitMode: "invite"})`.
 */
export async function mintLinkAndConfirmInvite(
  input: MintAndConfirmInput,
): Promise<MintAndConfirmResult> {
  const { invitee, slot, intent, callerUserId } = input;

  const startDate = new Date(slot.start);
  const endDate = new Date(slot.end);
  const derivedDuration =
    intent.durationMinutes ??
    Math.round((endDate.getTime() - startDate.getTime()) / 60000);

  // ── Mint contextual link ────────────────────────────────────────────────
  const createLinkParams: Record<string, unknown> = {
    inviteeNames: invitee.name ? [invitee.name] : [],
    inviteeEmail: invitee.email,
    ...(intent.activity ? { activity: intent.activity } : {}),
    ...(intent.durationMinutes ? { duration: intent.durationMinutes } : {}),
    ...(intent.format ? { format: intent.format } : {}),
    ...(intent.topic ? { note: intent.topic } : {}),
    ...(intent.hostNote ? { hostNote: intent.hostNote } : {}),
    ...(intent.location ? { location: intent.location } : {}),
  };

  const createResult = await handleCreateLink(createLinkParams, callerUserId);

  if (!createResult.success) {
    return {
      ok: false,
      reason: "validation_failed",
      message: createResult.message ?? "Failed to create meeting link",
    };
  }

  const sessionId = createResult.data?.sessionId as string | undefined;
  if (!sessionId) {
    return {
      ok: false,
      reason: "validation_failed",
      message: "Link created but no session ID returned",
    };
  }

  // ── Confirm the booking ─────────────────────────────────────────────────
  const confirmResult = await confirmBooking({
    sessionId,
    dateTime: slot.start,
    duration: intent.durationMinutes,
    format: intent.format,
    location: intent.location ?? null,
    guestEmail: invitee.email,
    guestName: invitee.name,
    userAgent: null,
  });

  if (!confirmResult.ok) {
    return {
      ok: false,
      reason: confirmResult.reason,
      message: confirmResult.message,
    };
  }

  // ── Resolve the dealRoom URL for the caller ─────────────────────────────
  const confirmedSession = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    select: { link: { select: { slug: true, code: true } } },
  });
  const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
  const meetingUrl =
    confirmedSession?.link?.code && confirmedSession?.link?.slug
      ? `${baseUrl}/meet/${confirmedSession.link.slug}/${confirmedSession.link.code}`
      : `${baseUrl}/meet/unknown`;

  return {
    ok: true,
    sessionId,
    meetingUrl,
    status: "confirmed",
    dateTime: confirmResult.dateTime,
    duration: confirmResult.duration ?? derivedDuration,
    format: confirmResult.format,
    location: confirmResult.location,
    emailSent: confirmResult.emailSent,
    ...(confirmResult.warnings ? { warnings: confirmResult.warnings } : {}),
    ...(confirmResult.calendarWriteUnavailable
      ? { calendarWriteUnavailable: true }
      : {}),
  };
}
