/**
 * MCP rate-limit counter — UPSERT pattern, atomic under READ COMMITTED.
 *
 * SPEC §1. One row per (tokenHash, tool, windowStart). Every increment is a
 * single UPSERT with `ON CONFLICT DO UPDATE` and a `CASE` expression that
 * evaluates the post-lock row state, so N concurrent increments within a
 * fresh window produce `finalCount === N` exactly. Window reset (when
 * server-side NOW() crosses the next bucket boundary) is atomic too — it's
 * the same UPSERT, just with the CASE branch that resets count to 1.
 *
 * Server-side NOW() is used throughout (not client clock) to defeat skew
 * attacks. Window boundary is `floor(epoch_seconds / windowDurationSec) *
 * windowDurationSec`, computed in SQL.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type RateLimitResult = {
  /** Post-increment count in the current window. */
  count: number;
  /** The boundary start (server-side) of the current window. */
  windowStart: Date;
  /** The boundary end — rows expire here. */
  expiresAt: Date;
  /** True iff `count > limit`. Caller decides what to do (429, etc). */
  exceeded: boolean;
};

export type RateLimitConfig = {
  /** MCP tool being rate-limited, e.g. "propose_lock". */
  tool: string;
  /** Plaintext capability token (`?c=<code>`). Hashed before DB write. */
  token: string;
  /** Max requests per window. */
  limit: number;
  /** Window size in seconds, e.g. 60. */
  windowSec: number;
};

/** SHA-256 hex of the plaintext capability token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Atomically increment the counter for (tokenHash, tool, currentWindow) and
 * return the new count. The CASE evaluates against the post-lock row state,
 * so reset-vs-increment is decided under the row lock held by
 * `ON CONFLICT DO UPDATE` — no lost updates, no double-reset.
 *
 * Implementation note: Prisma's $queryRaw is used because `upsert` can't
 * express the CASE without two round-trips. The RETURNING clause gives us
 * the final count in the same statement.
 */
export async function incrementRateCounter(
  cfg: RateLimitConfig,
): Promise<RateLimitResult> {
  const tokenHash = hashToken(cfg.token);
  const { tool, limit, windowSec } = cfg;

  // The SQL:
  // - Computes window boundary server-side.
  // - On insert: count = 1.
  // - On conflict: if the stored windowStart is still current, count += 1;
  //   otherwise the clock has crossed the boundary → reset count to 1,
  //   update windowStart and expiresAt.
  const rows = await prisma.$queryRaw<
    Array<{
      count: number;
      windowStart: Date;
      expiresAt: Date;
    }>
  >`
    WITH now_row AS (
      SELECT
        to_timestamp(
          floor(extract(epoch FROM NOW()) / ${windowSec}) * ${windowSec}
        ) AS window_start,
        to_timestamp(
          floor(extract(epoch FROM NOW()) / ${windowSec}) * ${windowSec}
            + ${windowSec}
        ) AS expires_at
    )
    INSERT INTO "MCPRateCounter" (
      "id", "tokenHash", "tool", "windowStart", "count", "expiresAt",
      "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid()::text,
      ${tokenHash},
      ${tool},
      n.window_start,
      1,
      n.expires_at,
      NOW(),
      NOW()
    FROM now_row n
    ON CONFLICT ("tokenHash", "tool", "windowStart") DO UPDATE
      SET
        "count" = CASE
          WHEN "MCPRateCounter"."windowStart" = EXCLUDED."windowStart"
            THEN "MCPRateCounter"."count" + 1
          ELSE 1
        END,
        "windowStart" = EXCLUDED."windowStart",
        "expiresAt"   = EXCLUDED."expiresAt",
        "updatedAt"   = NOW()
    RETURNING
      "count"       AS "count",
      "windowStart" AS "windowStart",
      "expiresAt"   AS "expiresAt"
  `;

  const row = rows[0];
  if (!row) {
    throw new Error("incrementRateCounter: UPSERT returned no rows");
  }

  return {
    count: row.count,
    windowStart: row.windowStart,
    expiresAt: row.expiresAt,
    exceeded: row.count > limit,
  };
}

/**
 * GC expired rows. Called by the hourly sweep cron.
 * @returns number of rows deleted
 */
export async function sweepExpiredRateCounters(now = new Date()): Promise<number> {
  const result = await prisma.mCPRateCounter.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return result.count;
}
