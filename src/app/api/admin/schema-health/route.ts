/**
 * GET /api/admin/schema-health
 *
 * Admin-gated endpoint that runs the schema drift check on demand and
 * returns the full report as JSON. Paired with the /api/cron/schema-health
 * background check — use this route for manual inspection, use the cron
 * for automated alerting.
 *
 * Non-admins get 404 (not 401/403) — deliberate, so the route's existence
 * isn't advertised.
 */

import { NextResponse } from "next/server";
import { isAdminSession } from "@/lib/admin-auth";
import { checkSchemaDrift } from "@/lib/schema-drift";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdminSession())) {
    return new NextResponse(null, { status: 404 });
  }

  try {
    const report = await checkSchemaDrift();
    return NextResponse.json(report);
  } catch (err) {
    // The check itself failed — usually means the DB is unreachable or
    // `information_schema` query permission is missing. Surface the error
    // explicitly so the admin knows the detector, not the schema, is broken.
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        detail: "Drift check failed before diffing — DB unreachable or permission issue.",
      },
      { status: 500 },
    );
  }
}
