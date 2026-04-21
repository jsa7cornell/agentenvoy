/**
 * Feedback bundle builder (F3 of the feedback-loops proposal, 2026-04-20).
 *
 * The server's own data is the source of truth. The client sends only the
 * free text, the checklist state, and headers (URL, UA). Every other field
 * is read from the DB keyed on `userId`.
 *
 * Calendar events go through `redactCalendarEvent` — the only path calendar
 * data can enter the bundle. Matching AgentEnvoy-originated events are
 * annotated with `agentenvoySessionId` by looking up NegotiationSession on
 * the host's calendarEventId.
 */

import { prisma } from "@/lib/prisma";
import { syncCalendar } from "@/lib/calendar";
import { redactCalendarEvent } from "@/lib/feedback/redact-calendar";
import {
  FeedbackBundleSchema,
  type ChecklistState,
  type FeedbackBundle,
  type FeedbackSubmitInput,
} from "@/lib/feedback/schema";

const MAX_MESSAGES = 30;
const MAX_SESSIONS = 10;
const CALENDAR_LOOKBACK_DAYS = 7;
const MAX_ROUTE_ERRORS = 50;
const ROUTE_ERROR_LOOKBACK_HOURS = 24;
const MAX_CONSOLE_LINES = 100;

export interface BuildBundleInput {
  userId: string;
  submission: FeedbackSubmitInput;
  /** Truncated app version (git sha prefix) — helpful for correlating with
   *  deploys. Optional; set by the API route from env. */
  appVersion?: string;
}

export async function buildFeedbackBundle(
  input: BuildBundleInput,
): Promise<FeedbackBundle> {
  const { userId, submission, appVersion } = input;
  const { checklistState, consoleLines, url, userAgent } = submission;

  const [messages, sessions, calendar, routeErrors] = await Promise.all([
    checklistState.messages ? loadRecentMessages(userId) : Promise.resolve(undefined),
    checklistState.sessions ? loadRecentSessions(userId) : Promise.resolve(undefined),
    checklistState.calendar ? loadRedactedCalendar(userId) : Promise.resolve(undefined),
    checklistState.errors ? loadRecentRouteErrors(userId) : Promise.resolve(undefined),
  ]);

  const bundle: FeedbackBundle = {
    version: 1,
    capturedAt: new Date().toISOString(),
    headers: {
      url,
      userAgent,
      appVersion,
    },
    messages,
    sessions,
    calendar,
    routeErrors,
    consoleLines: checklistState.console
      ? (consoleLines ?? []).slice(0, MAX_CONSOLE_LINES)
      : undefined,
  };

  // Belt-and-braces: validate what we wrote. If something bypasses the
  // redactor and injects an unallowed shape, this throws before the
  // insert ever happens.
  return FeedbackBundleSchema.parse(bundle);
}

async function loadRecentMessages(userId: string) {
  const rows = await prisma.channelMessage.findMany({
    where: { channel: { userId } },
    orderBy: { createdAt: "desc" },
    take: MAX_MESSAGES,
    select: {
      id: true,
      role: true,
      content: true,
      createdAt: true,
    },
  });
  return rows
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content ?? "",
      createdAt: r.createdAt.toISOString(),
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
    },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    agreedTime: r.agreedTime ? r.agreedTime.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function loadRedactedCalendar(userId: string) {
  const now = new Date();
  const since = new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * 24 * 3600 * 1000);

  // syncCalendar returns our trimmed CalendarEvent shape (no description,
  // attachments, or non-participant emails). We still route every one of
  // them through redactCalendarEvent — that's the architectural commitment.
  let events;
  try {
    const result = await syncCalendar(userId);
    events = result.events;
  } catch (err) {
    console.warn("[feedback.bundle] calendar sync failed — dropping calendar slice", { userId, err });
    return [];
  }

  const relevant = events.filter((e) => e.end >= since);

  // Match AgentEnvoy-originated events back to their session id. This is
  // the debugging signal reviewers flagged B1 for — without it a report
  // on an AgentEnvoy-booked meeting loses the correlation back to its
  // NegotiationSession.
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
