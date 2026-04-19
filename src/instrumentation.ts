/**
 * Next.js instrumentation hook — runs once per cold start in the Node.js
 * runtime. Used to catch schema drift immediately at boot rather than
 * waiting for the next hourly cron tick.
 *
 * If columns are missing in prod, this logs a CRITICAL error to the Vercel
 * runtime log within seconds of the first request. The drift cron and daily
 * email alert remain the primary notification path; this is belt-and-
 * suspenders for catching drift that slipped past `prisma migrate deploy`
 * (e.g., a manual DB change, a rollback to a prior deploy).
 *
 * Does NOT block startup — a startup failure would take down the entire app,
 * which is worse than serving degraded. Drift is logged and the cron handles
 * the alert email.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { checkSchemaDrift, formatDriftSummary } = await import(
      "@/lib/schema-drift"
    );
    const report = await checkSchemaDrift();
    if (!report.ok) {
      const summary = formatDriftSummary(report);
      console.error(
        `[boot] CRITICAL — schema drift detected at startup. Every Prisma query touching these models is failing.\n${summary}`,
      );
    }
  } catch (err) {
    // The check itself failed (e.g., DB unreachable at boot). Log and move on.
    console.error("[boot] Schema drift check failed:", err);
  }
}
