/**
 * AdminAccessLog helper (F5 of the feedback-loops proposal).
 *
 * Call logAdminAccess() at the top of any /admin/* surface that renders
 * user-specific data. One row per render = "who looked, at what, when."
 *
 * Design choices baked in:
 *   - `path` stores the route template (literal `:id`), not the resolved
 *     URL — `targetUserId` already carries the resolved user.
 *   - `action` is Zod-validated against the literal union before Prisma
 *     insert. Unknown actions throw in dev, coerce-to-"view" in prod so
 *     we never drop an audit row.
 *   - `/admin/access-log` is exempt — without the exemption every render
 *     of the log page would log a meta-row, filling the log indefinitely.
 *   - Failures are swallowed and console.error'd. An audit miss is bad;
 *     taking down the admin page because audit insert failed is worse.
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";

const ActionSchema = z.enum(["view", "list", "export"]);
export type AdminAccessAction = z.infer<typeof ActionSchema>;

// The access-log page reads its own rows; logging its own reads would
// grow the log without bound. The helper short-circuits on this path.
const EXEMPT_PATHS = new Set(["/admin/access-log"]);

export interface LogAdminAccessInput {
  adminId: string;
  path: string;
  action: AdminAccessAction;
  targetUserId?: string | null;
  context?: Record<string, unknown>;
}

export async function logAdminAccess(input: LogAdminAccessInput): Promise<void> {
  if (EXEMPT_PATHS.has(input.path)) return;

  const parsed = ActionSchema.safeParse(input.action);
  let action: AdminAccessAction;
  if (parsed.success) {
    action = parsed.data;
  } else {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `logAdminAccess: invalid action "${String(input.action)}" (expected "view" | "list" | "export")`,
      );
    }
    console.error("[admin.access-log] invalid action, coercing to 'view'", {
      path: input.path,
      received: input.action,
    });
    action = "view";
  }

  try {
    await prisma.adminAccessLog.create({
      data: {
        adminId: input.adminId,
        path: input.path,
        action,
        targetUserId: input.targetUserId ?? null,
        contextJson: (input.context ?? null) as never,
      },
    });
  } catch (err) {
    console.error("[admin.access-log] insert failed (non-blocking)", {
      path: input.path,
      err,
    });
  }
}
