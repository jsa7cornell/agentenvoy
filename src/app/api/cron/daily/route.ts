/**
 * GET /api/cron/daily
 *
 * The ONE daily cron. Vercel Hobby caps crons at one-per-day-per-job, so
 * instead of three separate daily crons we run everything in this single
 * sweep. Consolidating keeps the plan cheap and makes the "what runs
 * once a day" surface area obvious.
 *
 * Sequence (each phase is independent — a failure in one doesn't block
 * the others; errors collect into the response):
 *   1. Expire tentative holds past their TTL + delete backing GCal events
 *   2. Run the schema drift check; dispatch alert email if drift detected
 *   3. Build + dispatch the daily dev-stats digest
 *
 * The individual routes at /api/cron/expire-holds, /api/cron/schema-health,
 * and /api/cron/dev-stats are still callable manually (e.g. for ad-hoc
 * verification) — they're just not scheduled anymore.
 *
 * Auth: CRON_SECRET via Authorization Bearer header (Vercel Cron) or
 * ?secret= query (manual). Unsecured in local dev if CRON_SECRET unset.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dispatch } from "@/lib/side-effects/dispatcher";
import { deleteCalendarEvent } from "@/lib/calendar";
import { checkSchemaDrift, formatDriftSummary } from "@/lib/schema-drift";
import { logRouteError } from "@/lib/route-error";
import { buildDevStatsEmail } from "@/lib/emails/dev-stats";
import { gatherDevStats } from "@/lib/emails/dev-stats-gather";

// Cron routes must never be prerendered — see PLAYBOOK Rule 11.
export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SCHEMA_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

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

  const ranAt = new Date();
  const windowStart = new Date(ranAt.getTime() - WINDOW_MS);

  // ───────── Phase 1: expire holds ─────────
  const holdsResult = await runExpireHolds(ranAt);

  // ───────── Phase 2: schema drift ─────────
  const schemaResult = await runSchemaDriftCheck();

  // ───────── Phase 3: daily dev-stats digest ─────────
  const statsResult = await runDevStats(windowStart, ranAt);

  return NextResponse.json({
    ranAt: ranAt.toISOString(),
    holds: holdsResult,
    schemaHealth: schemaResult,
    devStats: statsResult,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — expire tentative holds past TTL
// ─────────────────────────────────────────────────────────────────────────────

async function runExpireHolds(now: Date): Promise<{
  swept: number;
  errors: string[];
}> {
  const expired = await prisma.hold.findMany({
    where: { status: "active", expiresAt: { lte: now } },
    select: {
      id: true,
      hostId: true,
      sessionId: true,
      slotStart: true,
      calendarEventId: true,
      session: {
        select: { link: { select: { inviteeName: true, code: true } } },
      },
    },
  });

  const errors: string[] = [];
  let swept = 0;

  for (const hold of expired) {
    if (hold.calendarEventId) {
      try {
        await deleteCalendarEvent(hold.hostId, hold.calendarEventId);
      } catch (e) {
        errors.push(`gcal delete ${hold.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    try {
      await prisma.hold.update({
        where: { id: hold.id },
        data: { status: "expired" },
      });
    } catch (e) {
      errors.push(`hold update ${hold.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    try {
      const name = hold.session.link.inviteeName || hold.session.link.code || "the guest";
      await prisma.message.create({
        data: {
          sessionId: hold.sessionId,
          role: "system",
          content: `Tentative hold for ${name} at ${hold.slotStart.toISOString()} expired without confirmation. Slot is available again.`,
        },
      });
    } catch (e) {
      errors.push(`system msg ${hold.id}: ${e instanceof Error ? e.message : String(e)}`);
    }

    swept += 1;
  }

  return { swept, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — schema drift check + rate-limited alert
// ─────────────────────────────────────────────────────────────────────────────

async function runSchemaDriftCheck(): Promise<{
  ok: boolean;
  affectedCount: number;
  alertDispatched: boolean;
  error?: string;
}> {
  try {
    const report = await checkSchemaDrift();
    if (report.ok) {
      return { ok: true, affectedCount: 0, alertDispatched: false };
    }

    const summary = formatDriftSummary(report);
    logRouteError({
      route: "/api/cron/daily",
      method: "GET",
      statusCode: 500,
      error: Object.assign(new Error(summary), { name: "SchemaDrift" }),
      context: {
        phase: "schema-drift",
        affected: report.affected.map((m) => ({
          model: m.model,
          table: m.table,
          tableMissing: m.tableMissing,
          missing: m.missing,
        })),
      },
    });

    const cutoff = new Date(Date.now() - SCHEMA_ALERT_COOLDOWN_MS);
    const recentAlert = await prisma.sideEffectLog.findFirst({
      where: {
        kind: "email.send",
        status: { in: ["sent", "suppressed", "dryrun"] },
        createdAt: { gte: cutoff },
        contextJson: { path: ["purpose"], equals: "schema_drift" },
      },
      select: { id: true },
    });

    let alertDispatched = false;
    if (!recentAlert) {
      const recipient = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";
      await dispatch({
        kind: "email.send",
        to: recipient,
        subject: `⚠ AgentEnvoy schema drift — ${report.affected.length} model(s) affected`,
        html: buildDriftAlertHtml(report, summary),
        context: {
          purpose: "schema_drift",
          affectedCount: report.affected.length,
          affectedTables: report.affected.map((m) => m.table),
        },
      });
      alertDispatched = true;
    }

    return {
      ok: false,
      affectedCount: report.affected.length,
      alertDispatched,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logRouteError({
      route: "/api/cron/daily",
      method: "GET",
      statusCode: 500,
      error: e,
      context: { phase: "schema-drift-check-failed" },
    });
    return { ok: false, affectedCount: 0, alertDispatched: false, error };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — daily dev-stats digest
// ─────────────────────────────────────────────────────────────────────────────

async function runDevStats(
  windowStart: Date,
  windowEnd: Date,
): Promise<{
  status: string;
  to: string;
}> {
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

  return { status: result.status, to: recipient };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drift-alert email (duplicated from /api/cron/schema-health to keep this
// file self-contained; the other route file is kept around for manual
// invocation but no longer scheduled).
// ─────────────────────────────────────────────────────────────────────────────

function buildDriftAlertHtml(
  report: {
    checkedAt: string;
    affected: Array<{ model: string; table: string; tableMissing: boolean; missing: string[] }>;
  },
  summary: string,
): string {
  const rows = report.affected
    .map((m) => {
      const detail = m.tableMissing
        ? `<em>entire table missing</em>`
        : m.missing.map(escapeHtml).join(", ");
      return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(m.table)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;">${detail}</td></tr>`;
    })
    .join("");
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
      <div style="background:#fff4e5;border:1px solid #ffb74d;border-radius:8px;padding:16px;margin-bottom:16px;">
        <div style="font-size:16px;font-weight:700;color:#b26a00;margin-bottom:4px;">Schema drift detected</div>
        <div style="font-size:13px;color:#5c4410;">
          Prisma expects columns that don't exist in production Postgres. Every query touching these models is failing.
          Fix by running the matching migration SQL in Supabase SQL Editor.
        </div>
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:16px;">
        <thead>
          <tr style="background:#fafafa;"><th style="text-align:left;padding:6px 8px;">Table</th><th style="text-align:left;padding:6px 8px;">Missing columns</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <pre style="background:#f8f8f8;border:1px solid #e0e0e0;border-radius:6px;padding:12px;font-size:12px;overflow-x:auto;">${escapeHtml(summary)}</pre>
      <p style="font-size:12px;color:#888;margin-top:20px;">
        Checked at ${escapeHtml(report.checkedAt)} · Alerts rate-limited to once per 4h.
        Full report: <a href="https://agentenvoy.ai/api/admin/schema-health" style="color:#6c5ce7;">/api/admin/schema-health</a>
      </p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
