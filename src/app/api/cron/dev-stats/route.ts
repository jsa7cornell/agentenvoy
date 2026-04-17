import { NextRequest, NextResponse } from "next/server";
import { dispatch } from "@/lib/side-effects/dispatcher";
import { buildDevStatsEmail } from "@/lib/emails/dev-stats";
import { gatherDevStats } from "@/lib/emails/dev-stats-gather";

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
    context: {
      purpose: "dev_stats",
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
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
