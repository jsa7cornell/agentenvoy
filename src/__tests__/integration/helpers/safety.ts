/**
 * Fail-closed safety check for integration-test DB access.
 *
 * Background: 2026-05-04 — integration tests ran against the production
 * database because POSTGRES_PRISMA_URL was loaded from an env that pointed
 * at prod. resetDb() TRUNCATEd every public table. All rows wiped.
 *
 * Defense in depth, layered closest-to-the-primitive:
 *   1. resetDb() itself calls assertSafeIntegrationDb() before any TRUNCATE.
 *   2. globalSetup() calls it before the suite starts (fail fast).
 *
 * Two independent gates are both required:
 *   (a) the connection string must parse to a hostname / database name we
 *       recognize as local-or-throwaway. Substring regex was the prior
 *       guard's failure mode — a prod URL containing the substring
 *       "agentenvoy_test" would have passed.
 *   (b) the caller must set INTEGRATION_TEST_DB_OK=1 in the current shell
 *       session. This is intentionally NOT stored in any .env file — running
 *       integration tests has to be a conscious act, not a reflex.
 *
 * The npm script `test:integration` sets the sentinel inline. A bare
 * `npx vitest --config vitest.integration.config.ts` will fail this gate.
 */

const ALLOWED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres", // common docker-compose service name
  "db", // common docker-compose service name
]);

const ALLOWED_DB_NAMES = new Set([
  "agentenvoy_test",
  "agentenvoy_ci",
]);

export class UnsafeIntegrationDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeIntegrationDbError";
  }
}

function redact(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

/**
 * Returns silently if the URL is safe to TRUNCATE against. Throws
 * UnsafeIntegrationDbError otherwise. Pure — no side effects, no I/O.
 *
 * Exported separately from the env-var gate so it can be unit-tested
 * without futzing with process.env.
 */
export function assertSafeIntegrationDbUrl(rawUrl: string): void {
  if (!rawUrl) {
    throw new UnsafeIntegrationDbError(
      "[integration-tests] REFUSED: POSTGRES_PRISMA_URL is empty.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeIntegrationDbError(
      `[integration-tests] REFUSED: POSTGRES_PRISMA_URL is not a valid URL.\n` +
        `  URL: ${redact(rawUrl)}`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  // pathname is `/dbname` or `/dbname?params`; strip the leading slash.
  const dbName = parsed.pathname.replace(/^\//, "").split("?")[0];

  const hostOk = ALLOWED_HOSTS.has(hostname);
  const dbNameOk = ALLOWED_DB_NAMES.has(dbName);

  // Must satisfy at least one — typically both, since CI / local dev set
  // them together. Either alone suffices in the unusual case where someone
  // points a hosted DB at a name we recognize as test-scoped (allowed) or
  // points localhost at an unconventionally-named DB (allowed).
  if (!hostOk && !dbNameOk) {
    throw new UnsafeIntegrationDbError(
      `[integration-tests] REFUSED to run against this DB.\n` +
        `  URL:      ${redact(rawUrl)}\n` +
        `  hostname: ${hostname} (allowed: ${[...ALLOWED_HOSTS].join(", ")})\n` +
        `  database: ${dbName} (allowed: ${[...ALLOWED_DB_NAMES].join(", ")})\n` +
        `  Integration tests TRUNCATE every public table. Point at a local\n` +
        `  Postgres first. See src/__tests__/integration/README.md.`,
    );
  }
}

/**
 * Composite gate — both the URL parse-check and the env-var sentinel must
 * pass. Call this at every entry point that could trigger destructive DB
 * work in an integration-test path.
 */
export function assertSafeIntegrationDb(): void {
  const url = process.env.POSTGRES_PRISMA_URL ?? process.env.DATABASE_URL ?? "";
  assertSafeIntegrationDbUrl(url);

  if (process.env.INTEGRATION_TEST_DB_OK !== "1") {
    throw new UnsafeIntegrationDbError(
      `[integration-tests] REFUSED: INTEGRATION_TEST_DB_OK=1 is not set.\n` +
        `  This sentinel must be set fresh per shell session — it is\n` +
        `  intentionally not stored in any .env file. Use:\n` +
        `    npm run test:integration\n` +
        `  which sets it inline. Running vitest directly bypasses this gate.`,
    );
  }
}
