/**
 * ConsentRequest create / accept / retract, plus the propose_lock guard.
 *
 * SPEC §2. Status transitions are one-way:
 *   pending → accepted | retracted | expired.
 *
 * Invariant: `propose_lock` refuses with `consent_not_accepted` if ANY
 * ConsentRequest row for (linkId, field) is in
 * {pending, retracted, expired} — no soft tolerance, no silent fall-through
 * to defaults. The guard returns a structured result; the caller maps it to
 * the MCP error surface.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ConsentStatus = "pending" | "accepted" | "retracted" | "expired";

export type ConsentDecidedBy = "guest" | "host_envoy" | "system_expired";

export type CreateConsentRequestInput = {
  linkId: string;
  sessionId?: string | null;
  field: string;
  appliedValue: Prisma.InputJsonValue;
  rationaleTemplate?: string | null;
  rationaleProse?: string | null;
  /** Optional explicit TTL. Default: 72h from now. */
  expiresAt?: Date;
};

const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;

export async function createConsentRequest(input: CreateConsentRequestInput) {
  return prisma.consentRequest.create({
    data: {
      linkId: input.linkId,
      sessionId: input.sessionId ?? null,
      field: input.field,
      appliedValue: input.appliedValue,
      rationaleTemplate: input.rationaleTemplate ?? null,
      rationaleProse: input.rationaleProse ?? null,
      expiresAt: input.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS),
      status: "pending",
    },
  });
}

export async function acceptConsentRequest(
  id: string,
  decidedBy: ConsentDecidedBy,
) {
  return prisma.consentRequest.update({
    where: { id },
    data: {
      status: "accepted",
      decidedBy,
      decidedAt: new Date(),
    },
  });
}

export async function retractConsentRequest(
  id: string,
  decidedBy: ConsentDecidedBy,
) {
  return prisma.consentRequest.update({
    where: { id },
    data: {
      status: "retracted",
      decidedBy,
      decidedAt: new Date(),
    },
  });
}

/** Sweep cron: flip pending+expired rows to status=expired. */
export async function expireConsentRequests(now = new Date()): Promise<number> {
  const result = await prisma.consentRequest.updateMany({
    where: { status: "pending", expiresAt: { lt: now } },
    data: {
      status: "expired",
      decidedBy: "system_expired",
      decidedAt: now,
    },
  });
  return result.count;
}

export type ConsentGuardResult =
  | { ok: true }
  | {
      ok: false;
      reason: "consent_not_accepted";
      blockingStatuses: ConsentStatus[];
    };

/**
 * Gate propose_lock on the absence of any non-accepted ConsentRequest for
 * the (linkId, field). Call immediately before writing the lock.
 *
 * Returns `{ ok: true }` iff every existing row is `accepted` (or none exist
 * — the field is freely lockable). Otherwise returns the blocking statuses
 * so the caller can emit a useful error.
 */
export async function guardConsentForProposeLock(
  linkId: string,
  field: string,
): Promise<ConsentGuardResult> {
  const rows = await prisma.consentRequest.findMany({
    where: { linkId, field },
    select: { status: true },
  });

  if (rows.length === 0) return { ok: true };

  const blocking = rows
    .map((r) => r.status as ConsentStatus)
    .filter((s) => s !== "accepted");

  if (blocking.length === 0) return { ok: true };

  // De-dupe for a stable error payload.
  const unique = Array.from(new Set(blocking));
  return {
    ok: false,
    reason: "consent_not_accepted",
    blockingStatuses: unique,
  };
}
