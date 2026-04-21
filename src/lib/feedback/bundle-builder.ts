/**
 * Feedback bundle builder (F3, upgraded to v2 per 2026-04-21).
 *
 * The server's own data is the source of truth. The client sends only
 * the free text, the checklist state, and headers (URL, UA). Every other
 * field is read from the DB keyed on `userId`.
 *
 * v2 additions (proposal §3, §T2c, §T2d, §T3b, §T3c):
 *   - filingContext — pre-computed digest the agent reads first.
 *   - messages.recentTurns / priorContext — chronological within each.
 *   - sessions[].linkCode + url — correlation back to the link.
 *   - recentLinks[] — full rules for any link touched by a recent action
 *     (host-only).
 *   - clientState — DOM snapshot captured at submit-time.
 *
 * Calendar events go through `redactCalendarEvent` — the only path
 * calendar data can enter the bundle.
 */

import { prisma } from "@/lib/prisma";
import { syncCalendar } from "@/lib/calendar";
import { redactCalendarEvent } from "@/lib/feedback/redact-calendar";
import {
  FeedbackBundleSchema,
  type ChecklistState,
  type FeedbackBundle,
  type FeedbackBundleV2,
  type FeedbackSubmitInput,
} from "@/lib/feedback/schema";
import {
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
const MAX_SESSIONS = 10;
const CALENDAR_LOOKBACK_DAYS = 7;
const MAX_ROUTE_ERRORS = 50;
const ROUTE_ERROR_LOOKBACK_HOURS = 24;
const MAX_CONSOLE_LINES = 100;
const RECENT_LINKS_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_LINKS = 10;

export interface BuildBundleInput {
  userId: string;
  submission: FeedbackSubmitInput;
  /** Truncated app version (git sha prefix) — helpful for correlating with
   *  deploys. Optional; set by the API route from env. */
  appVersion?: string;
  /** Request origin — needed for internal slots-replay fetch. Falls back to
   *  NEXTAUTH_URL. If neither is set, replay is skipped. */
  origin?: string | null;
}

export async function buildFeedbackBundle(
  input: BuildBundleInput,
): Promise<FeedbackBundle> {
  const { userId, submission, appVersion, origin } = input;
  const { checklistState, consoleLines, url, userAgent, clientState } = submission;
  const filedAt = new Date();

  // Replay is load-bearing for widget-display bugs: recentLinks[].rulesJson
  // is the rule (input), replay.slotsByDay is what the scoring engine would
  // serve RIGHT NOW. Agents correlating "what guest saw" need both.
  const replay =
    submission.area === "deal_room_chat" && submission.sessionId
      ? await fetchSlotsReplay({
          sessionId: submission.sessionId,
          origin,
        })
      : null;

  const [rawMessages, sessions, calendar, routeErrors] = await Promise.all([
    checklistState.messages ? loadRecentMessagesWithMeta(userId) : Promise.resolve([]),
    checklistState.sessions ? loadRecentSessions(userId) : Promise.resolve(undefined),
    checklistState.calendar ? loadRedactedCalendar(userId) : Promise.resolve(undefined),
    checklistState.errors ? loadRecentRouteErrors(userId) : Promise.resolve(undefined),
  ]);

  // Segment messages + build filingContext from the same ordered list.
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
  const recentTurns = ordered.slice(splitAt).map(toMessageWithMeta);
  const priorContext = ordered.slice(0, splitAt).map(toMessageWithMeta);

  const recentLinks =
    checklistState.messages && hasLinkActionInRecent(ordered, recentCount)
      ? await loadRecentLinks(userId)
      : undefined;

  const bundle: FeedbackBundleV2 = {
    version: 2,
    capturedAt: filedAt.toISOString(),
    headers: {
      url,
      userAgent,
      appVersion,
    },
    filingContext,
    messages: checklistState.messages
      ? { recentTurns, priorContext }
      : undefined,
    sessions,
    recentLinks,
    calendar,
    routeErrors,
    consoleLines: checklistState.console
      ? (consoleLines ?? []).slice(0, MAX_CONSOLE_LINES)
      : undefined,
    clientState,
    replay: replay ?? undefined,
  };

  return FeedbackBundleSchema.parse(bundle);
}

type MessageWithMeta = NonNullable<FeedbackBundleV2["messages"]>["recentTurns"][number];

function toMessageWithMeta(m: FilingMessage): MessageWithMeta {
  const meta = parseChannelMessageMetadata(m.metadata);
  const out: MessageWithMeta = {
    id: m.id,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
    content: m.content,
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
  if (meta.promptContext) {
    out.promptContext = meta.promptContext;
  }
  return out;
}

function hasLinkActionInRecent(messages: FilingMessage[], recentCount: number): boolean {
  const start = Math.max(0, messages.length - recentCount);
  for (let i = start; i < messages.length; i++) {
    const meta = parseChannelMessageMetadata(messages[i].metadata);
    const actions = meta.actions ?? [];
    for (const a of actions) {
      if (/link/i.test(a.action)) return true;
      if (typeof a.params.linkCode === "string") return true;
    }
  }
  return false;
}

async function loadRecentMessagesWithMeta(userId: string): Promise<FilingMessage[]> {
  const rows = await prisma.channelMessage.findMany({
    where: { channel: { userId } },
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
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content ?? "",
      createdAt: r.createdAt,
      metadata: r.metadata,
    }))
    .reverse();
}

async function loadRecentSessions(userId: string) {
  const rows = await prisma.negotiationSession.findMany({
    where: { hostId: userId },
    orderBy: { createdAt: "desc" },
    take: MAX_SESSIONS,
    select: {
      id: true,
      title: true,
      status: true,
      agreedTime: true,
      createdAt: true,
      link: {
        select: {
          code: true,
          slug: true,
        },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    agreedTime: r.agreedTime ? r.agreedTime.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    linkCode: r.link?.code ?? null,
    url: r.link?.code && r.link?.slug ? `/meet/${r.link.slug}/${r.link.code}` : null,
  }));
}

async function loadRecentLinks(userId: string) {
  const since = new Date(Date.now() - RECENT_LINKS_LOOKBACK_MS);
  const rows = await prisma.negotiationLink.findMany({
    where: {
      userId,
      OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }],
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_RECENT_LINKS,
    select: {
      code: true,
      slug: true,
      rules: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows
    .filter((r): r is typeof r & { code: string } => typeof r.code === "string")
    .map((r) => ({
      code: r.code,
      slug: r.slug ?? "",
      url: r.slug ? `/meet/${r.slug}/${r.code}` : `/meet/${r.code}`,
      rulesJson: r.rules ?? null,
      createdAt: r.createdAt.toISOString(),
      lastEditedAt: r.updatedAt.toISOString(),
    }));
}

async function loadRedactedCalendar(userId: string) {
  const now = new Date();
  const since = new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * 24 * 3600 * 1000);

  let events;
  try {
    const result = await syncCalendar(userId);
    events = result.events;
  } catch (err) {
    console.warn("[feedback.bundle] calendar sync failed — dropping calendar slice", { userId, err });
    return [];
  }

  const relevant = events.filter((e) => e.end >= since);

  const eventIds = relevant.map((e) => e.id).filter(Boolean);
  const sessionLinks =
    eventIds.length === 0
      ? []
      : await prisma.negotiationSession.findMany({
          where: { hostId: userId, calendarEventId: { in: eventIds } },
          select: { id: true, calendarEventId: true },
        });
  const sessionByEventId = new Map(
    sessionLinks
      .filter((s): s is { id: string; calendarEventId: string } => Boolean(s.calendarEventId))
      .map((s) => [s.calendarEventId, s.id]),
  );

  return relevant.map((e) => {
    const redacted = redactCalendarEvent(e);
    const sid = sessionByEventId.get(e.id);
    if (sid) redacted.agentenvoySessionId = sid;
    return redacted;
  });
}

async function loadRecentRouteErrors(userId: string) {
  const since = new Date(Date.now() - ROUTE_ERROR_LOOKBACK_HOURS * 3600 * 1000);
  const rows = await prisma.routeError.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: MAX_ROUTE_ERRORS,
    select: {
      id: true,
      createdAt: true,
      route: true,
      method: true,
      errorClass: true,
      message: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    route: r.route,
    method: r.method ?? null,
    errorClass: r.errorClass ?? null,
    message: r.message,
  }));
}

/** Re-export for the submit route — keeps the callsite narrow. */
export type { ChecklistState };
