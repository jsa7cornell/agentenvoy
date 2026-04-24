/**
 * Host-facing notification emitters.
 *
 * Per proposal 2026-04-22 recurring-series R2 ("always notify — never silent
 * changes"), every schedule change writes a durable notification row. The
 * bell UI is v1.1+ (see WISHLIST `notification-bell-and-center`); this module
 * is the v1 write-only stub so no behavior is silent at the data layer even
 * before the UI ships.
 *
 * ## Design discipline
 *
 * - **Fail-soft.** Emitters catch-and-log; a notification-write failure never
 *   blocks the upstream action (reschedule, cancel, format change). Matches
 *   `onboarding/events.ts`.
 * - **Frozen actor label.** `actorLabel` is resolved once at write time
 *   ("Sam", "you") rather than joined at read time. Notifications read
 *   correctly even if the counterparty is deleted or renamed.
 * - **Minimal payload on write.** We write the bare event, not a render. The
 *   bell can style + enrich at read time. Forward-compat for redesigns.
 * - **No PII in `kind`.** The taxonomy is a small stable set of strings; PII
 *   lives in `headline` / `detail` / `actorLabel`, which the bell renderer
 *   will treat as untrusted text.
 *
 * ## Kinds (v1 set)
 *
 * - `schedule_changed` — a live session moved (time / format / location).
 * - `awaiting_ack_counterparty` — you proposed a change, counterparty hasn't
 *   responded. The counterparty sees `awaiting_ack_self`.
 * - `awaiting_ack_self` — counterparty proposed a change, you need to act.
 * - `ack_timed_out` — a proposal expired (per R4 this means the original
 *   state holds; notification is informational).
 * - `session_confirmed` — guest picked a slot; host's meeting is locked.
 * - `session_cancelled` — a session was cancelled (either side).
 * - `series_started` — anchor commit on a recurring series.
 * - `series_ended` — recurring series finished (last occurrence or explicit
 *   end by either party).
 * - `guest_signed_up` — a no-account guest created an AgentEnvoy account
 *   (Case C conversion signal; rendered as a celebratory row).
 *
 * New kinds are added over time; unknown kinds render as a generic row in the
 * UI. Always prefer a new `kind` over overloading an existing one.
 */

import { prisma } from "@/lib/prisma";

export type NotificationKind =
  | "schedule_changed"
  | "awaiting_ack_counterparty"
  | "awaiting_ack_self"
  | "ack_timed_out"
  | "session_confirmed"
  | "session_cancelled"
  | "series_started"
  | "series_ended"
  | "guest_signed_up";

export type NotificationActorKind = "host" | "guest" | "system";

export type NotificationCtaKind =
  | "ack_time"
  | "ack_format"
  | "ack_location"
  | "view_deal_room";

export interface EmitNotificationInput {
  /** Recipient — the user who sees this in their bell. */
  userId: string;
  kind: NotificationKind;
  /** Who or what caused the event. */
  actorKind: NotificationActorKind;
  /** Display label for the actor at write time. "Sam" / "you" / "Envoy". */
  actorLabel?: string | null;
  /** One-line summary. Hard-capped at 280 chars; longer content goes in `detail`. */
  headline: string;
  /** Optional longer body. No markdown; plain text. */
  detail?: string | null;
  /** FK hooks — all nullable, set whichever are known. */
  sessionId?: string | null;
  linkId?: string | null;
  linkOccurrenceId?: string | null;
  /** Optional inline action affordance. */
  cta?: {
    kind: NotificationCtaKind;
    payload: Record<string, unknown>;
  } | null;
}

const HEADLINE_MAX = 280;

function clampHeadline(s: string): string {
  if (s.length <= HEADLINE_MAX) return s;
  // Reserve 1 char for the ellipsis.
  return s.slice(0, HEADLINE_MAX - 1) + "…";
}

/**
 * Emit a notification. Fail-soft — never throws. Returns true on success,
 * false if the write failed (and logs the error). Callers do not need to
 * branch on the return value unless they want to surface retry UX.
 */
export async function emitNotification(
  input: EmitNotificationInput,
): Promise<boolean> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        actorKind: input.actorKind,
        actorLabel: input.actorLabel ?? null,
        headline: clampHeadline(input.headline),
        detail: input.detail ?? null,
        sessionId: input.sessionId ?? null,
        linkId: input.linkId ?? null,
        linkOccurrenceId: input.linkOccurrenceId ?? null,
        ctaKind: input.cta?.kind ?? null,
        ctaPayload: input.cta?.payload
          ? (input.cta.payload as object)
          : undefined,
      },
    });
    return true;
  } catch (e) {
    console.error("[notifications] emit failed:", e, {
      userId: input.userId,
      kind: input.kind,
    });
    return false;
  }
}

/**
 * Emit a pair of notifications representing a pending ack — one to the
 * proposer ("awaiting counterparty"), one to the recipient ("awaiting you").
 * Both point at the same underlying linkOccurrence so acceptance reconciles
 * both rows.
 *
 * Typical use: host proposes a time change on a recurring occurrence.
 * Proposer sees "Sam hasn't confirmed the move"; recipient sees "John wants
 * to move Friday to Thursday — confirm or counter?"
 */
export async function emitAckPair(opts: {
  proposerUserId: string;
  recipientUserId: string;
  proposerLabelForRecipient: string; // "John" (shown to the recipient)
  recipientLabelForProposer: string; // "Sam" (shown to the proposer)
  axis: "time" | "format" | "location";
  headlineForProposer: string;
  headlineForRecipient: string;
  detail?: string | null;
  linkId?: string | null;
  linkOccurrenceId?: string | null;
  ackPayload: Record<string, unknown>;
}): Promise<void> {
  const ctaKind: NotificationCtaKind =
    opts.axis === "time"
      ? "ack_time"
      : opts.axis === "format"
        ? "ack_format"
        : "ack_location";

  await Promise.all([
    emitNotification({
      userId: opts.proposerUserId,
      kind: "awaiting_ack_counterparty",
      actorKind: "system",
      actorLabel: opts.recipientLabelForProposer,
      headline: opts.headlineForProposer,
      detail: opts.detail,
      linkId: opts.linkId,
      linkOccurrenceId: opts.linkOccurrenceId,
      cta: null, // proposer has nothing to click yet
    }),
    emitNotification({
      userId: opts.recipientUserId,
      kind: "awaiting_ack_self",
      actorKind: "host", // proposer initiated; from recipient's view the proposer is the actor
      actorLabel: opts.proposerLabelForRecipient,
      headline: opts.headlineForRecipient,
      detail: opts.detail,
      linkId: opts.linkId,
      linkOccurrenceId: opts.linkOccurrenceId,
      cta: { kind: ctaKind, payload: opts.ackPayload },
    }),
  ]);
}
