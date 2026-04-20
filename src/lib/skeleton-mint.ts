/**
 * Generic-link skeleton mint.
 *
 * On a GET to `/meet/[slug]`, before we redirect the guest to the persistent
 * `/meet/[slug]/[code]` URL, we need a `NegotiationLink` + `NegotiationSession`
 * row pair that the code-URL page can resume against. This is the "skeleton"
 * — two inserts, no schedule compute, no greeting, no Claude call. The
 * heavy work happens on the code-URL page's `POST /api/negotiate/session`,
 * which resumes the 0-message session via the branch at `route.ts:371-374`
 * and runs the full greeting/schedule/Claude pipeline.
 *
 * Callers: `src/app/meet/[slug]/route.ts` (server-side redirect).
 *
 * See proposals/2026-04-20_generic-link-server-redirect_*.md for the
 * full rationale and the decision that split-mint beats full-server-mint.
 */

import { prisma } from "@/lib/prisma";
import { generateCode } from "@/lib/utils";

const GENERIC_TOPICS = new Set([
  "meeting", "catch up", "catch-up", "catchup", "chat", "sync",
  "check in", "check-in", "checkin", "connect", "touch base",
  "quick chat", "quick meeting", "quick sync", "discussion",
  "call", "quick call", "phone call", "video call",
]);

function buildSessionTitle(
  topic: string | null,
  inviteeName: string | null,
  hostFirstName: string,
): string {
  if (topic && !GENERIC_TOPICS.has(topic.trim().toLowerCase())) {
    return `${topic}${inviteeName ? ` — ${inviteeName}` : ""}`;
  }
  if (inviteeName) return `${hostFirstName} + ${inviteeName}`;
  return `Meeting — ${hostFirstName}`;
}

export interface SkeletonMintResult {
  /** The generated contextual code — use to build the `/meet/[slug]/[code]` URL. */
  code: string;
  /** NegotiationLink row id. */
  linkId: string;
  /** NegotiationSession row id. */
  sessionId: string;
}

/**
 * Mint a skeleton NegotiationLink + NegotiationSession for a generic-link
 * visit. The session has 0 messages; the code-URL page's POST handler will
 * hydrate it via the reuseSessionId branch.
 *
 * Throws if the slug doesn't resolve to a user — caller should 404.
 */
export async function mintGenericSkeleton(slug: string): Promise<SkeletonMintResult> {
  const user = await prisma.user.findUnique({
    where: { meetSlug: slug },
    select: { id: true, name: true, meetSlug: true },
  });
  if (!user || !user.meetSlug) {
    throw new Error(`No user for slug "${slug}"`);
  }

  const code = generateCode();
  const link = await prisma.negotiationLink.create({
    data: {
      userId: user.id,
      type: "contextual",
      slug: user.meetSlug,
      code,
    },
  });

  const hostFirstName = (user.name || "Host").split(/\s+/)[0];
  const lr = (link.rules as Record<string, unknown>) || {};
  const session = await prisma.negotiationSession.create({
    data: {
      linkId: link.id,
      hostId: user.id,
      type: "calendar",
      status: "active",
      title: buildSessionTitle(link.topic, link.inviteeName, hostFirstName),
      statusLabel: `Waiting for ${link.inviteeName || "invitee"}`,
      duration: (lr.duration as number) || 30,
      format: (lr.format as string) || null,
      // guestTimezone intentionally null here — the code-URL POST will
      // backfill from browser TZ on the first hit, respecting the
      // link.inviteeTimezone override rule.
    },
  });

  return { code, linkId: link.id, sessionId: session.id };
}
