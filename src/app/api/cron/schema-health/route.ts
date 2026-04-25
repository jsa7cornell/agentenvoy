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
import { checkSchemaDrift } from "@/lib/schema-drift";
import { logRouteError } from "@/lib/route-error";
import { alertSchemaDrift } from "@/lib/schema-drift-alert";

// Cron routes must never be prerendered — see PLAYBOOK Rule 11.
export const dynamic = "force-dynamic";

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

  const { emailDispatched, logId } = await alertSchemaDrift(report, { source: "cron" });

  return NextResponse.json(
    {
      ok: false,
      checkedAt: report.checkedAt,
      affected: report.affected.map((m) => ({
        table: m.table,
        tableMissing: m.tableMissing,
        missing: m.missing,
      })),
      emailDispatched,
      emailLogId: logId,
    },
    { status: 500 },
  );
}
