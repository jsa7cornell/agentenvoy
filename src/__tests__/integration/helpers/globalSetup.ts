import { prisma } from "./db";

const ALLOWED_DB_PATTERNS = [
  /localhost/,
  /127\.0\.0\.1/,
  /agentenvoy_test/,
];

/**
 * Vitest globalSetup: verify the test DB is reachable before the suite
 * runs so a misconfigured DATABASE_URL fails loudly, not via 30s test
 * timeouts. Returns a teardown closure that disconnects the Prisma
 * client so long runs don't exhaust pg's connection pool (reviewer N3).
 *
 * SAFETY GUARD: refuses to run if POSTGRES_PRISMA_URL looks like a
 * production host. Integration tests call TRUNCATE on every table —
 * pointing at a real database will wipe all user data.
 */
export default async function globalSetup() {
  const dbUrl = process.env.POSTGRES_PRISMA_URL ?? process.env.DATABASE_URL ?? "";
  const isSafe = ALLOWED_DB_PATTERNS.some((p) => p.test(dbUrl));
  if (!isSafe) {
    throw new Error(
      `[integration-tests] REFUSED to run: POSTGRES_PRISMA_URL does not look like a local/test database.\n` +
      `  URL: ${dbUrl.replace(/:[^:@]+@/, ":***@")}\n` +
      `  Integration tests TRUNCATE every table. Point DATABASE_URL at a local Postgres first.\n` +
      `  See src/__tests__/integration/README.md for setup instructions.`,
    );
  }

  // Smoke-check connectivity. Fails fast with a clear error if the URL
  // points at a missing database or the container isn't healthy yet.
  await prisma.$queryRaw`SELECT 1`;

  return async () => {
    await prisma.$disconnect();
  };
}
