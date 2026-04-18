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
import { checkEnvDrift, formatEnvDriftSummary } from "@/lib/env-drift";
import { logRouteError } from "@/lib/route-error";
import { buildDevStatsEmail } from "@/lib/emails/dev-stats";
import { gatherDevStats } from "@/lib/emails/dev-stats-gather";
import { buildMeetingReminderEmail } from "@/lib/emails/meeting-reminder";

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

  // ───────── Phase 3: env drift ─────────
  const envResult = await runEnvDriftCheck();

  // ───────── Phase 4: daily dev-stats digest ─────────
  const statsResult = await runDevStats(windowStart, ranAt);

  // ───────── Phase 5: 24h meeting reminders ─────────
  const remindersResult = await runMeetingReminders(ranAt);

  return NextResponse.json({
    ranAt: ranAt.toISOString(),
    holds: holdsResult,
    schemaHealth: schemaResult,
    envDrift: envResult,
    devStats: statsResult,
    reminders: remindersResult,
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
// Phase 3 — env-drift check
// ─────────────────────────────────────────────────────────────────────────────

const ENV_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

async function runEnvDriftCheck(): Promise<{
  ok: boolean;
  critical: number;
  warn: number;
  alertDispatched: boolean;
  error?: string;
}> {
  try {
    const report = checkEnvDrift();
    if (report.ok) {
      return { ok: true, critical: 0, warn: 0, alertDispatched: false };
    }

    const critical = report.findings.filter((f) => f.severity === "critical").length;
    const warn = report.findings.filter((f) => f.severity === "warn").length;
    const summary = formatEnvDriftSummary(report);

    logRouteError({
      route: "/api/cron/daily",
      method: "GET",
      statusCode: 500,
      error: Object.assign(new Error(summary), { name: "EnvDrift" }),
      context: {
        phase: "env-drift",
        findings: report.findings.map((f) => ({
          name: f.name,
          severity: f.severity,
          reason: f.reason,
        })),
      },
    });

    // Only email when something is critical — warns go into /admin/failures
    // but don't page.
    let alertDispatched = false;
    if (critical > 0) {
      const cutoff = new Date(Date.now() - ENV_ALERT_COOLDOWN_MS);
      const recentAlert = await prisma.sideEffectLog.findFirst({
        where: {
          kind: "email.send",
          status: { in: ["sent", "suppressed", "dryrun"] },
          createdAt: { gte: cutoff },
          contextJson: { path: ["purpose"], equals: "env_drift" },
        },
        select: { id: true },
      });

      if (!recentAlert) {
        const recipient = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";
        await dispatch({
          kind: "email.send",
          to: recipient,
          subject: `⚠ AgentEnvoy env drift — ${critical} critical env var issue(s)`,
          html: buildEnvDriftAlertHtml(report, summary),
          context: {
            purpose: "env_drift",
            critical,
            warn,
            names: report.findings.map((f) => f.name),
          },
        });
        alertDispatched = true;
      }
    }

    return { ok: false, critical, warn, alertDispatched };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logRouteError({
      route: "/api/cron/daily",
      method: "GET",
      statusCode: 500,
      error: e,
      context: { phase: "env-drift-check-failed" },
    });
    return { ok: false, critical: 0, warn: 0, alertDispatched: false, error };
  }
}

function buildEnvDriftAlertHtml(
  report: ReturnType<typeof checkEnvDrift>,
  summary: string,
): string {
  const rows = report.findings
    .map(
      (f) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #27272a;font-family:monospace;font-size:12px;">${escapeHtml(f.name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #27272a;font-size:12px;color:${f.severity === "critical" ? "#f87171" : "#fbbf24"};font-weight:600;">${f.severity}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #27272a;font-size:12px;">${escapeHtml(f.reason)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html><body style="margin:0;font-family:-apple-system,sans-serif;background:#09090b;color:#e4e4e7;padding:24px;">
  <div style="max-width:640px;margin:0 auto;background:#0c0c10;border:1px solid #27272a;border-radius:12px;padding:20px;">
    <div style="font-size:18px;font-weight:700;color:#fbbf24;margin-bottom:8px;">AgentEnvoy — env drift detected</div>
    <div style="font-size:13px;color:#a1a1aa;margin-bottom:16px;">
      The daily cron's env-drift sweep found one or more production env var
      issues. Fix in Vercel → Settings → Environment Variables. Alerts are
      rate-limited to once per 4 hours.
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #3f3f46;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;">Var</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #3f3f46;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;">Severity</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #3f3f46;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;">Reason</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <pre style="background:#09090b;border:1px solid #27272a;border-radius:8px;padding:12px;font-size:11px;color:#a1a1aa;overflow:auto;">${escapeHtml(summary)}</pre>
  </div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — daily dev-stats digest
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
// Phase 4 — 24h meeting reminders
// ─────────────────────────────────────────────────────────────────────────────

async function runMeetingReminders(now: Date): Promise<{
  scanned: number;
  sent: number;
  skipped: number;
  errors: string[];
}> {
  // Catch any meeting in the next 24 hours. Using `gt: now` as the lower
  // bound guarantees we never send a reminder after the event has passed.
  const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  let scanned = 0;
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    const sessions = await prisma.negotiationSession.findMany({
      where: {
        status: "agreed",
        archived: false,
        wantsReminder: true,
        agreedTime: { gt: now, lt: windowEnd },
      },
      select: {
        id: true,
        hostId: true,
        guestEmail: true,
        guestTimezone: true,
        agreedTime: true,
        agreedFormat: true,
        format: true,
        duration: true,
        meetLink: true,
        host: { select: { name: true, preferences: true } },
        link: { select: { inviteeName: true, slug: true, code: true } },
      },
    });

    scanned = sessions.length;

    for (const session of sessions) {
      try {
        // Idempotency: check SideEffectLog for a prior reminder on this session.
        const alreadySent = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "SideEffectLog"
          WHERE kind = 'email.send'
            AND status IN ('sent', 'suppressed', 'dryrun', 'failed')
            AND "contextJson"->>'sessionId' = ${session.id}
            AND "contextJson"->>'purpose' = 'meeting_reminder'
          LIMIT 1
        `;
        if (alreadySent.length > 0) {
          skipped += 1;
          continue;
        }

        if (!session.guestEmail) {
          skipped += 1;
          continue;
        }

        const agreedTime = session.agreedTime!;

        // Display timezone: prefer the guest's captured timezone (shown in
        // guest's local time so the reminder is actionable), fall back to host's
        // stored tz, then UTC.
        const hostPrefs = session.host.preferences as Record<string, unknown> | null;
        const hostTz = (hostPrefs?.explicit as Record<string, unknown> | undefined)?.timezone as string | undefined
          ?? (hostPrefs?.timezone as string | undefined)
          ?? "UTC";
        const displayTz = session.guestTimezone || hostTz;

        const displayDate = agreedTime.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: displayTz,
        });
        const displayTime = agreedTime.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: displayTz,
        });
        const tzAbbr = new Intl.DateTimeFormat("en-US", {
          timeZoneName: "short",
          timeZone: displayTz,
        })
          .formatToParts(agreedTime)
          .find((p) => p.type === "timeZoneName")?.value ?? displayTz;

        const durationMin = session.duration || 30;
        const agreedFormat = session.agreedFormat || session.format || "video";
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://agentenvoy.ai";
        const dealRoomUrl = session.link.code
          ? `${baseUrl}/meet/${session.link.slug}/${session.link.code}`
          : `${baseUrl}/meet/${session.link.slug}`;

        const { subject, html } = buildMeetingReminderEmail({
          guestName: session.link.inviteeName || null,
          hostName: session.host.name || "Your host",
          whenLabel: `${displayDate} at ${displayTime}`,
          timezoneLabel: tzAbbr,
          durationLabel: `${durationMin} min`,
          format: agreedFormat,
          location: null,
          meetLink: session.meetLink || null,
          dealRoomUrl,
        });

        const result = await dispatch({
          kind: "email.send",
          to: session.guestEmail,
          subject,
          html,
          context: {
            purpose: "meeting_reminder",
            sessionId: session.id,
            hostId: session.hostId,
          },
        });

        if (result.status === "failed") {
          errors.push(`reminder ${session.id}: ${result.error ?? "unknown"}`);
        } else {
          sent += 1;
        }
      } catch (e) {
        errors.push(`reminder ${session.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    errors.push(`scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { scanned, sent, skipped, errors };
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
