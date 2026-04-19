import { prisma } from "@/lib/prisma";
import { dispatch } from "@/lib/side-effects/dispatcher";

const ALERT_TO = "jsa7cornell@gmail.com";
const ALERT_FROM = "AgentEnvoy Alerts <noreply@agentenvoy.ai>";
/** Suppress duplicate alerts for the same route+errorClass within this window. */
const THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fire-and-forget server error logger. Persists a row to RouteError so
 * the /admin/failures page can surface it, then sends a one-per-hour email
 * alert via SES (throttled per route+errorClass).
 *
 * Never throws and never blocks the caller — if the DB write itself fails,
 * we fall back to console.error.
 *
 * Call sites: any API route's top-level `catch` (or an outer wrapper).
 *
 * Scope notes:
 *   - `message` is required; `stack` is truncated to 4000 chars.
 *   - `contextJson` must be safe to dump on an admin page — no secrets.
 *   - `userAgent` is truncated to 200 chars.
 */
export function logRouteError(params: {
  route: string;
  method?: string;
  statusCode?: number;
  error: unknown;
  context?: Record<string, unknown>;
  userId?: string;
  userAgent?: string | null;
}): void {
  const { route, method, statusCode, error, context, userId } = params;
  const userAgent = params.userAgent?.slice(0, 200) ?? undefined;

  const errObj = error instanceof Error ? error : new Error(String(error));
  const stack = errObj.stack ? errObj.stack.slice(0, 4000) : undefined;
  const errorClass = errObj.name || "Error";
  const message = errObj.message || "Unknown error";

  // Fire-and-forget — promise ignored intentionally.
  prisma.routeError
    .create({
      data: {
        route,
        method,
        statusCode,
        errorClass,
        message,
        stack,
        contextJson: context ? (context as object) : undefined,
        userId,
        userAgent,
      },
    })
    .then(async (created) => {
      // Throttle: only alert if no identical route+errorClass fired in the last hour.
      const recentDupes = await prisma.routeError.count({
        where: {
          route,
          errorClass,
          createdAt: { gte: new Date(Date.now() - THROTTLE_MS) },
          id: { not: created.id },
        },
      });
      if (recentDupes > 0) return; // already alerted this window

      const deploySha =
        process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
      const when = created.createdAt.toISOString();
      const msgPreview = message.slice(0, 500);

      await dispatch({
        kind: "email.send",
        to: ALERT_TO,
        from: ALERT_FROM,
        subject: `[AgentEnvoy] Route error: ${method ?? ""} ${route}`.trim(),
        html: buildAlertHtml({
          route,
          method,
          statusCode,
          errorClass,
          message: msgPreview,
          deploySha,
          when,
        }),
        context: {
          purpose: "route-error-alert",
          routeErrorId: created.id,
          route,
          errorClass,
        },
      });
    })
    .catch((dbErr) => {
      console.error(
        `[route-error] Failed to persist RouteError for ${route}:`,
        dbErr,
        "original error:",
        error,
      );
    });
}

function buildAlertHtml(params: {
  route: string;
  method?: string;
  statusCode?: number;
  errorClass: string;
  message: string;
  deploySha: string;
  when: string;
}): string {
  const { route, method, statusCode, errorClass, message, deploySha, when } =
    params;
  const status = statusCode ? `${statusCode} ` : "";
  const methodStr = method ? `${method} ` : "";

  return `<!DOCTYPE html>
<html>
<body style="font-family:monospace;background:#0a0a0a;color:#e4e4e7;padding:24px;margin:0">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto">
    <tr><td>
      <div style="background:#18181b;border:1px solid #3f3f46;border-radius:8px;padding:24px">
        <p style="margin:0 0 4px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.08em">AgentEnvoy · Route Error Alert</p>
        <h2 style="margin:0 0 20px;font-size:18px;color:#f87171">${status}${methodStr}${route}</h2>

        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">
          <tr>
            <td style="color:#a1a1aa;padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top">Error class</td>
            <td style="color:#e4e4e7;padding:6px 0">${errorClass}</td>
          </tr>
          <tr>
            <td style="color:#a1a1aa;padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top">Message</td>
            <td style="color:#e4e4e7;padding:6px 0;word-break:break-word">${escapeHtml(message)}</td>
          </tr>
          <tr>
            <td style="color:#a1a1aa;padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top">Deploy SHA</td>
            <td style="color:#e4e4e7;padding:6px 0"><code>${deploySha}</code></td>
          </tr>
          <tr>
            <td style="color:#a1a1aa;padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top">When</td>
            <td style="color:#e4e4e7;padding:6px 0">${when}</td>
          </tr>
        </table>

        <div style="margin-top:20px;padding-top:16px;border-top:1px solid #27272a">
          <a href="https://agentenvoy.ai/admin/failures"
             style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:13px">
            View in /admin/failures →
          </a>
        </div>

        <p style="margin:16px 0 0;font-size:11px;color:#52525b">
          Throttled to 1 alert/hr per route+error-class. Subsequent occurrences visible at /admin/failures.
        </p>
      </div>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
