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
 *   - Metadata allowlist: guest bundles strip host-only fields
 *     (promptContext, overriddenNarration). See filterMetadataForGuest.
 *
 * Bumped to v2 (2026-04-21 agent-accessible-feedback-pipeline §3): same
 * shape as the host v2 bundle, minus the host-only slices (recentLinks,
 * routeErrors, calendar, cross-session messages).
 */

import { prisma } from "@/lib/prisma";
import {
  FeedbackBundleSchema,
  type FeedbackBundle,
  type FeedbackBundleV2,
  type FeedbackSubmitAsGuestInput,
} from "@/lib/feedback/schema";
import {
  filterMetadataForGuest,
  parseChannelMessageMetadata,
  type ActionCall,
  type ActionResultRecord,
} from "@/lib/channel/metadata-schema";
import {
  buildFilingContext,
  computeRecentTurnsCount,
  type FilingMessage,
} from "@/lib/feedback/build-filing-context";
import { fetchSlotsReplay } from "@/lib/feedback/replay-slots";

const MAX_MESSAGES = 40;
const RECENT_TURNS_BASELINE = 10;

const GUEST_VISIBLE_ROLES = new Set([
  "host",
  "guest",
  "administrator",
  "guest_envoy",
  "external_agent",
]);

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
  /** Request origin — needed for internal slots-replay fetch. Falls back to
   *  NEXTAUTH_URL. Scoped to the guest's deal-room session. */
  origin?: string | null;
}

export async function buildGuestFeedbackBundle(
  input: BuildGuestBundleInput,
): Promise<FeedbackBundle> {
  const { link, host, session, submission, appVersion, origin } = input;
  const filedAt = new Date();

  // Replay is load-bearing for widget-display bugs. Same guest symmetry
  // invariant as elsewhere: replay runs against the session the guest is
  // viewing, which the guest is already authorized to see.
  let replay: Awaited<ReturnType<typeof fetchSlotsReplay>> = null;
  if (submission.area === "deal_room_chat" && session?.id) {
    try {
      replay = await fetchSlotsReplay({ sessionId: session.id, origin });
    } catch (err) {
      console.warn("[feedback.bundle.guest] replay fetch threw — dropping replay slice", { err });
      replay = null;
    }
  }

  const rawMessages = submission.includeContext
    ? await loadSharedChannelMessagesWithMeta(host.id, session?.id ?? null)
    : [];

  const ordered = rawMessages;
  const filingContext = ordered.length > 0
    ? buildFilingContext(ordered, filedAt)
    : buildFilingContext([], filedAt);

  const incidentId = filingContext.suspectedIncidentTurn?.messageId ?? null;
  const recentCount = computeRecentTurnsCount(
    ordered.length,
    incidentId,
    ordered,
    RECENT_TURNS_BASELINE,
  );
  const splitAt = Math.max(0, ordered.length - recentCount);
  const recentTurns = ordered.slice(splitAt).map(toGuestMessageWithMeta);
  const priorContext = ordered.slice(0, splitAt).map(toGuestMessageWithMeta);

  const bundle: FeedbackBundleV2 = {
    version: 2,
    capturedAt: filedAt.toISOString(),
    headers: {
      url: submission.url,
      userAgent: submission.userAgent,
      appVersion,
    },
    filingContext,
    filedByGuest: true,
    sharedChannel: submission.includeContext
      ? { recentTurns, priorContext }
      : undefined,
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
    clientState: submission.clientState,
    replay: replay ?? undefined,
    // Explicitly NOT set: messages (host-path), recentLinks (host-only),
    // calendar (cross-trust-boundary), routeErrors (host-scoped),
    // consoleLines (not captured on guest path).
  };

  const firstParse = FeedbackBundleSchema.safeParse(bundle);
  if (firstParse.success) return firstParse.data;
  console.warn("[feedback.bundle.guest] schema parse failed — retrying without replay", {
    issues: firstParse.error.flatten(),
  });
  return FeedbackBundleSchema.parse({ ...bundle, replay: undefined });
}

type MessageWithMeta = NonNullable<FeedbackBundleV2["sharedChannel"]>["recentTurns"][number];

function toGuestMessageWithMeta(m: FilingMessage): MessageWithMeta {
  const raw = parseChannelMessageMetadata(m.metadata);
  const meta = filterMetadataForGuest(raw);
  const out: MessageWithMeta = {
    id: m.id,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
    content: stripActionPayloads(m.content ?? ""),
  };
  if (meta.actions && meta.actions.length > 0) {
    out.actions = meta.actions.map((a: ActionCall) => ({
      action: a.action,
      params: a.params,
    }));
  }
  if (meta.actionResults && meta.actionResults.length > 0) {
    out.actionResults = meta.actionResults.map((r: ActionResultRecord) => ({
      action: r.action,
      success: r.success,
      message: r.message,
      ...(r.data ? { data: r.data } : {}),
    }));
  }
  // promptContext is intentionally NOT copied — it's a host-only field
  // stripped by filterMetadataForGuest.
  return out;
}

/**
 * Load ChannelMessage rows the guest would have rendered in this link's
 * session. Returns oldest→newest for filingContext / segmentation.
 */
async function loadSharedChannelMessagesWithMeta(
  hostUserId: string,
  sessionId: string | null,
): Promise<FilingMessage[]> {
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
    .filter((r) => GUEST_VISIBLE_ROLES.has(r.role))
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content ?? "",
      createdAt: r.createdAt,
      metadata: r.metadata,
    }))
    .reverse();
}
