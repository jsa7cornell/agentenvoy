/**
 * GET /api/admin/env-health
 *
 * On-demand env-drift check. Paired with the Phase 3 run inside
 * /api/cron/daily — use this route for manual inspection, use the cron
 * for daily automated alerting.
 *
 * OAuth-gated to ADMIN_EMAIL; 404s otherwise (route existence hidden).
 */

import { NextResponse } from "next/server";
import { isAdminSession } from "@/lib/admin-auth";
import { checkEnvDrift } from "@/lib/env-drift";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdminSession())) {
    return new NextResponse(null, { status: 404 });
  }
  const report = checkEnvDrift();
  return NextResponse.json(report);
}
