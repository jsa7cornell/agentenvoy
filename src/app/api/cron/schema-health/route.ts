/**
 * GET /api/cron/schema-health
 *
 * Scheduled schema drift check. Runs the same introspection as the admin
 * endpoint, but on a cron and with alerting.
 *
 * Behavior:
 *   - Drift absent → returns `{ ok: true }`. No email, no RouteError.
 *   - Drift present → writes a RouteError (so it surfaces on
 *     /admin/failures) and dispatches an alert email to ADMIN_EMAIL. Rate-
 *     limited to at most one email per 4 hours to avoid spam if drift
 *     persists across multiple ticks.
 *
 * Auth: same pattern as /api/cron/dev-stats — CRON_SECRET via Authorization
 * header (Vercel Cron) or ?secret= query (manual). Unsecured in local dev
 * if CRON_SECRET isn't set, for easy smoke testing.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dispatch } from "@/lib/side-effects/dispatcher";
import { checkSchemaDrift, formatDriftSummary } from "@/lib/schema-drift";
import { logRouteError } from "@/lib/route-error";

// Cron routes must never be prerendered — see PLAYBOOK Rule 11.
export const dynamic = "force-dynamic";

const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

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

  let report;
  try {
    report = await checkSchemaDrift();
  } catch (err) {
    // The check itself failed — logging to RouteError means it surfaces on
    // /admin/failures alongside drift alerts. The route still returns 500
    // so the cron dashboard flags the failure.
    logRouteError({
      route: "/api/cron/schema-health",
      method: "GET",
      statusCode: 500,
      error: err,
      context: { phase: "checkSchemaDrift" },
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  if (report.ok) {
    return NextResponse.json({ ok: true, checkedAt: report.checkedAt });
  }

  // Drift. Always log a RouteError every tick so /admin/failures reflects
  // current state; rate-limit emails separately.
  const summary = formatDriftSummary(report);
  logRouteError({
    route: "/api/cron/schema-health",
    method: "GET",
    statusCode: 500,
    error: Object.assign(new Error(summary), { name: "SchemaDrift" }),
    context: {
      affected: report.affected.map((m) => ({
        model: m.model,
        table: m.table,
        tableMissing: m.tableMissing,
        missing: m.missing,
      })),
    },
  });

  // Check for a recent alert email to avoid spamming if drift persists.
  const cutoff = new Date(Date.now() - ALERT_COOLDOWN_MS);
  const recentAlert = await prisma.sideEffectLog.findFirst({
    where: {
      kind: "email.send",
      status: { in: ["sent", "suppressed", "dryrun"] },
      createdAt: { gte: cutoff },
      contextJson: {
        path: ["purpose"],
        equals: "schema_drift",
      },
    },
    select: { id: true },
  });

  let emailResult: { status: string; logId: string } | null = null;
  if (!recentAlert) {
    const recipient = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";
    const html = buildDriftAlertHtml(report, summary);
    const dispatched = await dispatch({
      kind: "email.send",
      to: recipient,
      subject: `⚠ AgentEnvoy schema drift — ${report.affected.length} model(s) affected`,
      html,
      context: {
        purpose: "schema_drift",
        affectedCount: report.affected.length,
        affectedTables: report.affected.map((m) => m.table),
      },
    });
    emailResult = { status: dispatched.status, logId: dispatched.logId };
  }

  return NextResponse.json(
    {
      ok: false,
      checkedAt: report.checkedAt,
      affected: report.affected.map((m) => ({
        table: m.table,
        tableMissing: m.tableMissing,
        missing: m.missing,
      })),
      emailDispatched: emailResult !== null,
      emailResult,
    },
    { status: 500 },
  );
}

function buildDriftAlertHtml(
  report: { checkedAt: string; affected: Array<{ model: string; table: string; tableMissing: boolean; missing: string[] }> },
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
