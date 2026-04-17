import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dispatch } from "@/lib/side-effects/dispatcher";
import {
  buildDevStatsEmail,
  type DevStatsFailure,
  type DevStatsFormatBreakdown,
  type DevStatsParams,
} from "@/lib/emails/dev-stats";

/**
 * GET /api/cron/dev-stats
 *
 * Daily digest emailed to the creator. Pure counts over the last 24h —
 * new users, sessions created, sessions by terminal status, agreed meeting
 * formats, failed SideEffectLog rows. No narrative, no charts.
 *
 * Auth: same pattern as /api/cron/expire-holds — CRON_SECRET header
 * (Vercel Cron) or ?secret= query (manual dev invocation).
 *
 * Recipient: ADMIN_EMAIL env var, defaults to jsa7cornell@gmail.com. Exactly
 * one recipient; this is explicitly not a generic digest system.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const fromHeader = auth?.replace(/^Bearer\s+/i, "");
    const fromQuery = new URL(req.url).searchParams.get("secret");
    if (fromHeader !== secret && fromQuery !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - WINDOW_MS);

  const stats = await gatherDevStats(windowStart, windowEnd);

  const recipient = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";
  const { subject, html } = buildDevStatsEmail(stats);

  const result = await dispatch({
    kind: "email.send",
    to: recipient,
    subject,
    html,
    context: { purpose: "dev_stats", windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
  });

  return NextResponse.json({
    status: result.status,
    mode: result.mode,
    logId: result.logId,
    to: recipient,
    stats: {
      newUsers: stats.newUsers,
      sessionsCreated: stats.sessionsCreated,
      sessionsConfirmed: stats.sessionsConfirmed,
      sessionsCancelled: stats.sessionsCancelled,
      sessionsExpired: stats.sessionsExpired,
      sessionsEscalated: stats.sessionsEscalated,
      totalFailures: stats.totalFailures,
    },
    ranAt: windowEnd.toISOString(),
  });
}

export async function gatherDevStats(windowStart: Date, windowEnd: Date): Promise<DevStatsParams> {
  const [
    newUsers,
    sessionsCreated,
    sessionsConfirmed,
    sessionsCancelledArchive,
    sessionsExpired,
    sessionsEscalated,
    agreedSessions,
    failedEffects,
  ] = await Promise.all([
    prisma.user.count({
      where: { createdAt: { gte: windowStart, lt: windowEnd } },
    }),
    prisma.negotiationSession.count({
      where: { createdAt: { gte: windowStart, lt: windowEnd } },
    }),
    // Sessions whose terminal transition to "agreed" fell in the window.
    // NegotiationSession lacks a dedicated `agreedAt`; updatedAt is the best proxy
    // since the confirm route's CAS is the last write that flips status.
    prisma.negotiationSession.count({
      where: {
        status: "agreed",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    }),
    // No "cancelled" status exists — cancellations set archived=true on a
    // previously-agreed session. Approximate by archived flips in-window.
    prisma.negotiationSession.count({
      where: {
        archived: true,
        status: "agreed",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    }),
    prisma.negotiationSession.count({
      where: {
        status: "expired",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    }),
    prisma.negotiationSession.count({
      where: {
        status: "escalated",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    }),
    prisma.negotiationSession.groupBy({
      by: ["agreedFormat"],
      where: {
        status: "agreed",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
      _count: { _all: true },
    }),
    prisma.sideEffectLog.groupBy({
      by: ["kind"],
      where: {
        status: "failed",
        createdAt: { gte: windowStart, lt: windowEnd },
      },
      _count: { _all: true },
    }),
  ]);

  const formatBreakdown: DevStatsFormatBreakdown[] = agreedSessions
    .map((row) => ({
      format: row.agreedFormat ?? "(unspecified)",
      count: row._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  const failures: DevStatsFailure[] = failedEffects
    .map((row) => ({ kind: row.kind, count: row._count._all }))
    .sort((a, b) => b.count - a.count);

  const totalFailures = failures.reduce((sum, f) => sum + f.count, 0);

  return {
    windowStart,
    windowEnd,
    newUsers,
    sessionsCreated,
    sessionsConfirmed,
    sessionsCancelled: sessionsCancelledArchive,
    sessionsExpired,
    sessionsEscalated,
    formatBreakdown,
    failures,
    totalFailures,
  };
}
