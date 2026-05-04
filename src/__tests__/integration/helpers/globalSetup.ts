import { prisma } from "./db";
import { assertSafeIntegrationDb } from "./safety";

/**
 * Vitest globalSetup: verify the test DB is reachable before the suite
 * runs so a misconfigured DATABASE_URL fails loudly, not via 30s test
 * timeouts. Returns a teardown closure that disconnects the Prisma
 * client so long runs don't exhaust pg's connection pool (reviewer N3).
 *
 * SAFETY GUARD: refuses to run if POSTGRES_PRISMA_URL doesn't parse to a
 * known-local host / known-test database name, or if the
 * INTEGRATION_TEST_DB_OK=1 sentinel is missing. The same check runs again
 * inside resetDb() — defense in depth, layered closest-to-the-primitive.
 * See helpers/safety.ts and post-mortem 2026-05-04.
 */
export default async function globalSetup() {
  assertSafeIntegrationDb();

  // Smoke-check connectivity. Fails fast with a clear error if the URL
  // points at a missing database or the container isn't healthy yet.
  await prisma.$queryRaw`SELECT 1`;

  return async () => {
    await prisma.$disconnect();
  };
}
