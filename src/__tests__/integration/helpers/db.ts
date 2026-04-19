import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client for integration tests. Under
 * `pool: 'forks', singleFork: true` (see vitest.integration.config.ts)
 * one process owns the entire suite, so one client is enough.
 *
 * Disconnect lives in `globalTeardown.ts` so long runs don't saturate
 * the pg 15 service container's default 100-connection pool (reviewer N3).
 */
export const prisma = new PrismaClient();

/** System tables to skip when truncating. */
const SKIP_TABLES = new Set<string>(["_prisma_migrations"]);

let TABLES: string[] | null = null;

async function discoverTables(): Promise<string[]> {
  if (TABLES) return TABLES;
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  TABLES = rows.map((r) => r.table_name).filter((t) => !SKIP_TABLES.has(t));
  return TABLES;
}

/**
 * Wipe every user-data table in the test database. Schema-driven — reads
 * `information_schema.tables` at first call and caches the list for the
 * process lifetime. Adding a model to `schema.prisma` plus re-running
 * `prisma db push` is enough; no truncate-list to update (reviewer B2).
 *
 * `CASCADE` handles FK order; `RESTART IDENTITY` resets sequences.
 *
 * @param opts.skipTables - rare opt-out for tests that deliberately share
 *   state across cases. Prefer a fresh fixture; use this sparingly.
 */
export async function resetDb(opts: { skipTables?: string[] } = {}): Promise<void> {
  const all = await discoverTables();
  const skip = new Set(opts.skipTables ?? []);
  const tables = all.filter((t) => !skip.has(t));
  if (tables.length === 0) return;
  const quoted = tables.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${quoted} RESTART IDENTITY CASCADE`
  );
}
