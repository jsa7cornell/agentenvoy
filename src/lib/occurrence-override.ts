/**
 * applyOccurrenceOverride — per-occurrence divergence writer for recurring series.
 *
 * Upserts a LinkOccurrence row on the (linkId, originalStartAt) unique key.
 * Two-tab race: second writer wins on all scalar fields except divergedBy
 * (preserved from the first writer). gcalInstanceId is captured on the first
 * GCal response and never overwritten by a null.
 *
 * Ordering invariant (proposal 2026-05-14 §3.5.1 B4): DB-write first, GCal
 * patch second (via the side-effects dispatcher, NOT inside this function).
 * This avoids holding a pg connection open for the duration of the Google API
 * call. If the GCal patch fails, the row persists with gcalInstanceId=null;
 * a background sync job (PR4) can reconcile.
 *
 * Proposal: proposals/2026-05-14_recurring-event-page-render-and-confirm_
 *   reviewed-2026-05-14_decided-2026-05-14.md §3.5.1
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  readRecurrence,
  isAnchorCommitted,
  expandRecurrence,
} from "@/lib/recurrence";

// ── Core helper ───────────────────────────────────────────────────────────────

export type OccurrenceStatus =
  | "cancelled"
  | "rescheduled"
  | "format_changed"
  | "location_changed";

export interface OccurrenceOverrideInput {
  linkId: string;
  originalStartAt: Date;
  status: OccurrenceStatus;
  /** "host" | "guest" — who initiated. First-writer wins; update preserves original. */
  divergedBy: "host" | "guest";
  divergedAt?: Date;
  actualStartAt?: Date | null;
  actualEndAt?: Date | null;
  actualFormat?: string | null;
  actualLocation?: string | null;
  /** Captured from first GCal instance-patch response. Never overwritten with null. */
  gcalInstanceId?: string | null;
  /**
   * null = bilateral ACK pending (time-change path, per proposal R4).
   * "accepted" = auto-acked (format/location/cancel — non-time divergence).
   */
  counterpartyAck?: "accepted" | "rejected" | null;
  reason?: string | null;
}

export interface OccurrenceOverrideResult {
  id: string;
  linkId: string;
  originalStartAt: Date;
  status: string;
  gcalInstanceId: string | null;
}

export async function applyOccurrenceOverride(
  input: OccurrenceOverrideInput,
): Promise<OccurrenceOverrideResult> {
  const now = new Date();
  const divergedAt = input.divergedAt ?? now;

  const createData = {
    linkId: input.linkId,
    originalStartAt: input.originalStartAt,
    status: input.status,
    divergedBy: input.divergedBy,
    divergedAt,
    ...(input.actualStartAt !== undefined ? { actualStartAt: input.actualStartAt } : {}),
    ...(input.actualEndAt !== undefined ? { actualEndAt: input.actualEndAt } : {}),
    ...(input.actualFormat !== undefined ? { actualFormat: input.actualFormat } : {}),
    ...(input.actualLocation !== undefined ? { actualLocation: input.actualLocation } : {}),
    ...(input.gcalInstanceId != null ? { gcalInstanceId: input.gcalInstanceId } : {}),
    ...(input.counterpartyAck !== undefined ? { counterpartyAck: input.counterpartyAck } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };

  // On conflict: update all fields EXCEPT divergedBy (preserve original initiator)
  // and gcalInstanceId (never overwrite a captured id with null).
  const updateData: Record<string, unknown> = {
    status: input.status,
    divergedAt,
    ...(input.actualStartAt !== undefined ? { actualStartAt: input.actualStartAt } : {}),
    ...(input.actualEndAt !== undefined ? { actualEndAt: input.actualEndAt } : {}),
    ...(input.actualFormat !== undefined ? { actualFormat: input.actualFormat } : {}),
    ...(input.actualLocation !== undefined ? { actualLocation: input.actualLocation } : {}),
    ...(input.counterpartyAck !== undefined ? { counterpartyAck: input.counterpartyAck } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
  // Only write gcalInstanceId when we have a real value (never null-overwrite).
  if (input.gcalInstanceId != null) {
    updateData.gcalInstanceId = input.gcalInstanceId;
  }

  const row = await prisma.linkOccurrence.upsert({
    where: {
      linkId_originalStartAt: {
        linkId: input.linkId,
        originalStartAt: input.originalStartAt,
      },
    },
    create: createData,
    update: updateData,
    select: {
      id: true,
      linkId: true,
      originalStartAt: true,
      status: true,
      gcalInstanceId: true,
    },
  });

  return row;
}

// ── "Next upcoming occurrence" resolver ───────────────────────────────────────

/**
 * Resolves the next upcoming occurrence start for a recurring link.
 * Returns null when the anchor hasn't been committed (pre-pick state) or when
 * all occurrences are in the past.
 *
 * Used by cancel_meeting / reschedule_meeting when `occurrence` param is absent
 * on a recurring-link session — "cancel this" defaults to "cancel the next one."
 */
export function resolveNextUpcomingOccurrence(
  linkRecurrenceJson: Prisma.JsonValue | null | undefined,
  now: Date = new Date(),
): Date | null {
  const rec = readRecurrence(linkRecurrenceJson);
  if (!rec) return null;
  if (!isAnchorCommitted(rec)) return null;

  // Expand from now to 2 years out — enough to find the next occurrence without
  // materialising the full 520-occurrence cap for every cancel call.
  const horizon = new Date(now.getTime() + 365 * 2 * 24 * 60 * 60 * 1000);
  const occurrences = expandRecurrence(rec, now, horizon);
  return occurrences[0]?.startAt ?? null;
}
