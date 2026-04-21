/**
 * Guest-path feedback bundle builder (deal-room symmetry proposal, 2026-04-21).
 *
 * Invariants (load-bearing; see proposal §2 and N1):
 *   - A guest-filed bundle NEVER contains data the guest didn't render-see.
 *   - Scope is channel-only: no calendar, no RouteError, no cross-session,
 *     no other channels. Only the linkCode's NegotiationLink → host.channel
 *     messages that share the session (or, if no session, the most recent
 *     thread on that link).
 *   - Content filter: role allowlist + `[ACTION]...[/ACTION]` strip. System
 *     messages and host_note are removed — they are hidden at the deal-room
 *     render layer for guest viewers, so they must also be hidden at the
 *     bundle sink.
 *
 * If anything in `deal-room.tsx`'s guest-render filter changes, update
 * GUEST_VISIBLE_ROLES here to match.
 */

import { prisma } from "@/lib/prisma";
import {
  FeedbackBundleSchema,
  type FeedbackBundle,
  type FeedbackSubmitAsGuestInput,
} from "@/lib/feedback/schema";

const MAX_MESSAGES = 30;

/**
 * Roles the deal-room render layer shows to a guest viewer. Anything else
 * is stripped at the bundle sink. Mirrors deal-room.tsx render-loop rules:
 *   - `system` is stripped (includes `guest_calendar_snapshot` hidden as
 *     internal LLM context, and `host_update` hidden from guest viewers).
 *   - `host_note` is host-only.
 */
const GUEST_VISIBLE_ROLES = new Set([
  "host",
  "guest",
  "administrator",
  "guest_envoy",
  "external_agent",
]);

/**
 * Strips `[ACTION]...[/ACTION]` JSON payloads from message content.
 * These are server-emitted control tokens the deal-room render path
 * parses into UI effects (proposal cards, time pickers) — they shouldn't
 * bleed into a feedback bundle as raw text.
 */
function stripActionPayloads(content: string): string {
  return content
    .replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/g, "")
    .trim();
}

export interface BuildGuestBundleInput {
  link: { id: string; code: string; hostId: string };
  host: { id: string; email: string | null };
  session: {
    id: string;
    title: string | null;
    status: string;
    agreedTime: Date | null;
    guestName: string | null;
    guestEmail: string | null;
  } | null;
  submission: FeedbackSubmitAsGuestInput;
  appVersion?: string;
}

export async function buildGuestFeedbackBundle(
  input: BuildGuestBundleInput,
): Promise<FeedbackBundle> {
  const { link, host, session, submission, appVersion } = input;

  const messages = submission.includeContext
    ? await loadSharedChannelMessages(host.id, session?.id ?? null)
    : [];

  const bundle: FeedbackBundle = {
    version: 1,
    capturedAt: new Date().toISOString(),
    headers: {
      url: submission.url,
      userAgent: submission.userAgent,
      appVersion,
    },
    filedByGuest: true,
    sharedChannel: submission.includeContext ? { messages } : undefined,
    session: session
      ? {
          id: session.id,
          title: session.title,
          status: session.status,
          agreedTime: session.agreedTime ? session.agreedTime.toISOString() : null,
        }
      : undefined,
    link: {
      code: link.code,
      hostEmail: host.email,
    },
    guestIdentity: session
      ? {
          name: session.guestName,
          email: session.guestEmail,
        }
      : undefined,
    // Explicitly NOT set: messages (host-path), sessions (cross-session),
    // calendar (cross-trust-boundary), routeErrors (host-scoped),
    // consoleLines (not captured on guest path).
  };

  return FeedbackBundleSchema.parse(bundle);
}

/**
 * Load ChannelMessage rows the guest would have rendered in this link's
 * session. Scope is the host's Channel (there is one per user) filtered to
 * messages tied to the current session's threadId — which is what the
 * deal-room render loop uses.
 *
 * If we don't have a sessionId, fall back to the most recent messages on
 * the channel (bounded by MAX_MESSAGES) — matches the proposal §2 shape
 * for "shared channel" and avoids pulling in unrelated sessions.
 */
async function loadSharedChannelMessages(
  hostUserId: string,
  sessionId: string | null,
) {
  const where = sessionId
    ? { channel: { userId: hostUserId }, threadId: sessionId }
    : { channel: { userId: hostUserId }, threadId: null };

  const rows = await prisma.channelMessage.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: MAX_MESSAGES,
    select: {
      id: true,
      role: true,
      content: true,
      createdAt: true,
      metadata: true,
    },
  });

  return rows
    .filter((r) => {
      if (!GUEST_VISIBLE_ROLES.has(r.role)) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: stripActionPayloads(r.content ?? ""),
      createdAt: r.createdAt.toISOString(),
    }))
    .reverse();
}
