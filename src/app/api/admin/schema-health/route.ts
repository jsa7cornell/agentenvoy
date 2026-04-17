/**
 * GET /api/admin/schema-health
 *
 * OAuth-gated (ADMIN_EMAIL) endpoint that runs the schema drift check on
 * demand and returns the full report as JSON. Paired with the
 * /api/cron/schema-health background check — use this route for manual
 * inspection, use the cron for automated alerting.
 *
 * Non-admins get 404 (not 401/403) — deliberate, so the route's existence
 * isn't advertised.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { checkSchemaDrift } from "@/lib/schema-drift";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (
    !session?.user?.email ||
    session.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()
  ) {
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
