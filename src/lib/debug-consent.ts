/**
 * Debug-consent helpers (F4 of the feedback-loops proposal, 2026-04-20).
 *
 * `debugConsent = true` on User grants admins permission to read that
 * user's thread + calendar data via admin drawers without per-incident
 * consent. It is access-gating, not capture-gating — we don't collect
 * anything extra; we gate *admin readability of existing data*.
 *
 * Revocation is immediate and checked fresh per-request — never cached.
 * Already-viewed audit rows (AdminAccessLog) and feedback reports stay
 * for audit integrity; this helper only controls *new* reads.
 */

import { prisma } from "@/lib/prisma";

export interface DebugConsentState {
  granted: boolean;
  grantedAt: Date | null;
  revokedAt: Date | null;
}

/** Read the current consent state for a user. Returns all-false on unknown id. */
export async function getDebugConsent(userId: string): Promise<DebugConsentState> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      debugConsent: true,
      debugConsentAt: true,
      debugConsentRevokedAt: true,
    },
  });
  if (!row) return { granted: false, grantedAt: null, revokedAt: null };
  return {
    granted: row.debugConsent,
    grantedAt: row.debugConsentAt,
    revokedAt: row.debugConsentRevokedAt,
  };
}

export interface SetDebugConsentInput {
  userId: string;
  granted: boolean;
  /** Override the timestamp (for tests); defaults to `new Date()` at call time. */
  now?: Date;
}

/**
 * Flip the consent flag. Granting stamps `debugConsentAt`; revoking stamps
 * `debugConsentRevokedAt`. Toggling back to a state the user is already in
 * does not re-stamp — the first-transition timestamp is preserved so the
 * audit trail reflects when the user actually opted in, not when the UI
 * last rendered.
 */
export async function setDebugConsent(input: SetDebugConsentInput): Promise<DebugConsentState> {
  const { userId, granted } = input;
  const now = input.now ?? new Date();

  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      debugConsent: true,
      debugConsentAt: true,
      debugConsentRevokedAt: true,
    },
  });
  if (!current) {
    throw new Error(`setDebugConsent: user ${userId} not found`);
  }
  if (current.debugConsent === granted) {
    return {
      granted: current.debugConsent,
      grantedAt: current.debugConsentAt,
      revokedAt: current.debugConsentRevokedAt,
    };
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: granted
      ? { debugConsent: true, debugConsentAt: now }
      : { debugConsent: false, debugConsentRevokedAt: now },
    select: {
      debugConsent: true,
      debugConsentAt: true,
      debugConsentRevokedAt: true,
    },
  });
  return {
    granted: updated.debugConsent,
    grantedAt: updated.debugConsentAt,
    revokedAt: updated.debugConsentRevokedAt,
  };
}

/**
 * Gate helper for admin surfaces that render a target user's thread or
 * calendar data. Returns the target user (id + email) if consented, or
 * null if not. Callsites typically `notFound()` on null — mirroring the
 * "unknown target" shape so admins can't distinguish "doesn't exist"
 * from "hasn't consented."
 *
 * This is deliberately a boolean gate, not a redirect — the caller owns
 * the UX of the non-consent branch (render an explainer, or 404).
 */
export async function loadConsentedTarget(
  targetUserId: string,
): Promise<{ id: string; email: string | null } | null> {
  const row = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, email: true, debugConsent: true },
  });
  if (!row || !row.debugConsent) return null;
  return { id: row.id, email: row.email };
}
