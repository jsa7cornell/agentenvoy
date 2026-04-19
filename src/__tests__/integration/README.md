# Integration tests

Tests that hit a **real Postgres database**. The unit suite mocks Prisma;
the E2E suite hits an HTTP endpoint but never asserts DB state. These
tests close that gap — they're the only place concurrency claims
(`updateMany` CAS, `UPSERT` atomicity, retraction ordering) are
actually verified.

Shipped per [2026-04-19 · Integration test harness proposal](../../../../../proposals/2026-04-19_integration-test-harness_reviewed-2026-04-19_decided-2026-04-19.md).

## Running the tests

```bash
npm run test:unit         # unit tests (no DB)
npm run test:e2e          # browser E2E (dev server + real HTTP)
npm run test:integration  # this suite — requires pg
npm run test:all          # unit + integration + e2e, in that order
```

### Locally

Spin up a throwaway pg 15 and provision it:

```bash
docker run --name ae-test-pg -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 -d postgres:15

export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agentenvoy_test"
export POSTGRES_URL_NON_POOLING="$DATABASE_URL"
export EFFECT_MODE_EMAIL=log
export EFFECT_MODE_CALENDAR=dryrun

# Create the database (postgres image starts with 'postgres' only):
psql "postgresql://postgres:postgres@localhost:5432/postgres" \
  -c "CREATE DATABASE agentenvoy_test"

# Provision the schema directly from schema.prisma (no migration history):
npx prisma db push --skip-generate

npm run test:integration
```

**Never point `DATABASE_URL` at a real database while running this
suite.** `resetDb()` truncates every non-system table in `public`.

### In CI

The `integration` job in `.github/workflows/ci.yml` spins up a pg 15
service container per job, provisions it with `prisma db push`, and
runs `npm run test:integration`. Required check on PR merge.

## Rules

1. **No shared seed.** Integration tests MUST NOT import from
   `prisma/seed.ts`. Fixtures live in `helpers/fixtures.ts` and return
   fresh rows per invocation. Inter-test coupling via shared seed is
   forbidden (harness proposal reviewer N5).
2. **Schema provisioning is `prisma db push`, not `migrate deploy`.**
   This harness intentionally decouples from migration history — `db push`
   reads `schema.prisma` directly. Migration validity is the job of
   [`2026-04-18 · Schema management and deploy infra`](../../../../../proposals/2026-04-18_schema-management-and-deploy-infra_reviewed-2026-04-18_decided-2026-04-18_shipped-2026-04-19.md)'s
   Track A' validator (already shipped).
3. **Side-effect env in tests.** `EFFECT_MODE_EMAIL=log` and
   `EFFECT_MODE_CALENDAR=dryrun` are set in the CI env block so the
   dispatcher writes `SideEffectLog` rows without calling external
   services. Tests assert on those rows; they never assume real dispatch.
4. **`resetDb()` default is full wipe.** The optional `{ skipTables }`
   parameter exists for rare shared-state cases — use sparingly; the
   fresh-fixture path is the default.
5. **Connection lifecycle.** Disconnect happens in
   `helpers/globalSetup.ts`'s teardown closure — do not import and
   disconnect Prisma in individual test files.

## Mutation-test procedure — confirm-pipeline concurrency test

> **Purpose:** prove `confirm-pipeline.concurrency.test.ts` is
> load-bearing — that it catches the class of bug it exists to catch,
> not just that it runs green on good code.

### When to run this

- Any time anyone touches the CAS at
  `src/app/api/negotiate/confirm/route.ts` (currently line ~276, search
  for `updateMany` with `status: { not: "agreed" }`).
- After any refactor of `confirm-pipeline` into shared libraries per
  [2026-04-18 · MCP two-Envoy handshake](../../../../../proposals/2026-04-18_mcp-two-envoy-handshake_reviewed-2026-04-18.md).
- Quarterly, regardless of changes.

### Steps

1. Open `src/app/api/negotiate/confirm/route.ts`.
2. Find the CAS:

   ```ts
   const casResult = await prisma.negotiationSession.updateMany({
     where: { id: { in: sessionIdsToUpdate }, status: { not: "agreed" } },
     data: { status: "agreed", ... },
   });
   ```

3. **Remove the CAS guard** — change `status: { not: "agreed" }` so the
   `where` no longer enforces "only if still active." One way:

   ```ts
   where: { id: { in: sessionIdsToUpdate } },   // guard removed
   ```

4. Run `npm run test:integration`.
5. **The `confirm-pipeline.concurrency` test MUST fail.** Specifically:
   - The "two parallel confirms" case should now show `a.count + b.count === 2`
     (both winners) instead of `1`.
   - The "sequential second confirm is a no-op" case should show
     `second.count === 1` and the final `agreedFormat` as `"phone"`,
     not `"video"`.
6. **Restore the CAS guard.** Re-run the test. It should pass again.

### If the test still passes without the guard

The test is no longer load-bearing. **Do not ship the underlying code
change** — fix the test first, then repeat this procedure. Options:
tighten the assertion, add a new assertion that depends on the guard,
or escalate for a reviewer to add a Stryker mutation job (v2 — out of
scope for v1 of the harness).

### Why not Stryker today?

Stryker mutation testing automates this check and runs in CI. Author
and reviewer agreed it's the right v2 — but the v1 harness ships with
a human-run procedure because (a) Stryker setup for a Prisma/Postgres
suite is non-trivial, and (b) the v1 harness has exactly one flagship
test, so the human-run cost is "do this once per CAS change."
Revisit when the suite grows past ~5 concurrency tests.
