# `e2e/_helpers/` — shared helpers for AgentEnvoy Playwright scenarios

Layer 1 of the production-verification proposal
([proposals/2026-05-13_claude-production-verification-infra_..._decided-2026-05-13.md](../../../proposals/2026-05-13_claude-production-verification-infra_reviewed-2026-05-13_decided-2026-05-13.md)).

## Rule 0.5 compliance — API-only seeding

**Helpers in this folder MUST NOT write to the database directly.** No `prisma` imports,
no `@supabase/supabase-js` writes, no raw SQL.

To set up scenario state, POST to the running dev server's existing API endpoints
(create-link, create-session, etc.) with a known test-user JWT. The seed *is* the
scenario — using real API endpoints means each test exercises the same code path a
real guest would.

This eliminates the Rule 0.5 surface entirely: even if `POSTGRES_PRISMA_URL` points
at prod, the harness can't write to it because it doesn't have a DB client. The dev
server gates the writes through its own auth + validation layer.

If a future scenario needs state that no API endpoint can produce (e.g., simulate a
corrupted row), the fallback path is to either:

1. Motivate a new test-only endpoint (visible at code review), or
2. Import `scripts/lib/db-target.ts` and refuse unless both `POSTGRES_PRISMA_URL` and
   `POSTGRES_URL_NON_POOLING` classify as local-target.

Option (1) is preferred. Option (2) requires sign-off in a follow-up proposal.

## Verification driver = Playwright MCP

Claude drives these tests via Playwright MCP (`@playwright/mcp`), not Claude-Preview
or Claude-in-Chrome. Install via:

```bash
claude mcp add playwright npx @playwright/mcp@latest
```

Then ask Claude to run a scenario. The MCP boots Chromium, executes the spec, and
reports DOM-driven pass/fail back into the conversation.

## R-class drift to watch for

Per the review's predicted pitfall P3:

> **Playwright must not enter `.husky/pre-commit` under any condition.** If a future
> agent proposes it, that's an R-class drift the reviewer should block. Playwright is
> opt-in locally (`npm run test:e2e:browser`) and gated in CI (Layer 3, separate
> implementation). The "velocity is the asset" constraint is non-negotiable.

## Running locally

1. Have `npm run dev` already running in another terminal (the config sets
   `reuseExistingServer: true`, so Playwright won't try to boot Next.js cold).
2. `npm run test:e2e:browser` — headless run.
3. `npm run test:e2e:browser:ui` — interactive UI mode, useful for authoring.
