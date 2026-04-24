/**
 * Shared drift-alert dispatcher. Used by both:
 *   - the daily schema-health cron (/api/cron/schema-health), and
 *   - the instrumentation.ts boot check (fires on every cold start).
 *
 * Dedup is via SideEffectLog: if a schema_drift email was dispatched in
 * the last 4h, skip. Means a bad deploy with many cold starts + a daily
 * cron tick = one email per 4h, not one per cold start.
 */

import { prisma } from "@/lib/prisma";
import { dispatch } from "@/lib/side-effects/dispatcher";
import { logRouteError } from "@/lib/route-error";
import { getLogRecipients } from "@/lib/log-recipients";
import { formatDriftSummary, type SchemaDriftReport } from "@/lib/schema-drift";

const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

export interface AlertOptions {
  /** Where the drift was noticed. Only used for the RouteError record. */
  source: "cron" | "boot";
}

export async function alertSchemaDrift(
  report: SchemaDriftReport,
  opts: AlertOptions,
): Promise<{ emailDispatched: boolean; logId: string | null }> {
  const summary = formatDriftSummary(report);

  logRouteError({
    route: opts.source === "boot" ? "instrumentation/boot" : "/api/cron/schema-health",
    method: "GET",
    statusCode: 500,
    error: Object.assign(new Error(summary), { name: "SchemaDrift" }),
    context: {
      source: opts.source,
      affected: report.affected.map((m) => ({
        model: m.model,
        table: m.table,
        tableMissing: m.tableMissing,
        missing: m.missing,
      })),
    },
  });

  const cutoff = new Date(Date.now() - ALERT_COOLDOWN_MS);
  const recentAlert = await prisma.sideEffectLog.findFirst({
    where: {
      kind: "email.send",
      status: { in: ["sent", "suppressed", "dryrun"] },
      createdAt: { gte: cutoff },
      contextJson: { path: ["purpose"], equals: "schema_drift" },
    },
    select: { id: true },
  });
  if (recentAlert) return { emailDispatched: false, logId: null };

  const recipient = getLogRecipients();
  const html = buildDriftAlertHtml(report, summary);
  const dispatched = await dispatch({
    kind: "email.send",
    to: recipient,
    subject: `⚠ AgentEnvoy schema drift — ${report.affected.length} model(s) affected`,
    html,
    context: {
      purpose: "schema_drift",
      source: opts.source,
      affectedCount: report.affected.length,
      affectedTables: report.affected.map((m) => m.table),
    },
  });
  return { emailDispatched: true, logId: dispatched.logId };
}

function buildDriftAlertHtml(report: SchemaDriftReport, summary: string): string {
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
