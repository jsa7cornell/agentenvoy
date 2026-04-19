import { prisma } from "./db";

/**
 * Vitest globalSetup: verify the test DB is reachable before the suite
 * runs so a misconfigured DATABASE_URL fails loudly, not via 30s test
 * timeouts. Returns a teardown closure that disconnects the Prisma
 * client so long runs don't exhaust pg's connection pool (reviewer N3).
 */
export default async function globalSetup() {
  // Smoke-check connectivity. Fails fast with a clear error if the URL
  // points at a missing database or the container isn't healthy yet.
  await prisma.$queryRaw`SELECT 1`;

  return async () => {
    await prisma.$disconnect();
  };
}
