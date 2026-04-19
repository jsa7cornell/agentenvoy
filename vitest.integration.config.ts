import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Integration test config — hits a real Postgres database.
 *
 * In CI, the database is a pg 15 service container provisioned via
 * `prisma db push --skip-generate` (see .github/workflows/ci.yml).
 * Locally, point DATABASE_URL at a throwaway local pg (docker) and run
 * `npx prisma db push --skip-generate` against it first.
 *
 * Tests run in a single fork so DB access serializes. See the harness
 * proposal §2 (truncate-between-tests) and §"Scaling ceiling" for the
 * exit strategy if the suite grows past ~50 tests.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 15_000,
    include: ["src/__tests__/integration/**/*.test.ts"],
    pool: "forks",
    // DB access must serialize. vitest v4 replaced the old
    // `poolOptions.forks.singleFork` with `fileParallelism: false` +
    // per-file `sequence.concurrent: false` (unit-level serial).
    fileParallelism: false,
    sequence: { concurrent: false },
    globalSetup: ["./src/__tests__/integration/helpers/globalSetup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
