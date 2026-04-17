import { prisma } from "@/lib/prisma";

/**
 * Fire-and-forget server error logger. Persists a row to RouteError so
 * the /admin/failures page can surface it. Never throws and never blocks
 * the caller — if the DB write itself fails, we fall back to console.error.
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

  // Fire-and-forget — promise ignored intentionally. We prefer visibility
  // in /admin/failures over strict durability; if the DB write fails we
  // fall through to console.error, which still lands in Vercel logs.
  prisma.routeError
    .create({
      data: {
        route,
        method,
        statusCode,
        errorClass: errObj.name || "Error",
        message: errObj.message || "Unknown error",
        stack,
        contextJson: context ? (context as object) : undefined,
        userId,
        userAgent,
      },
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
