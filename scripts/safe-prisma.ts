#!/usr/bin/env tsx
/**
 * Destructive Prisma command wrapper — DB protection hygiene.
 *
 * Background: 2026-05-04 prod-DB-wipe (integration tests against prod) and
 * 2026-05-10 near-miss (`prisma migrate dev` against prod from a dev shell)
 * both share a root cause: a single env var name (`POSTGRES_PRISMA_URL`)
 * resolves to either the destroyable local DB or undestroyable prod
 * depending on shell state, and the destructive commands trust whatever
 * URL they see. This wrapper sits in front of the three destructive Prisma
 * commands (`migrate dev`, `migrate reset`, `db push --force-reset`) and
 * refuses to invoke the real prisma binary if either `POSTGRES_PRISMA_URL`
 * or `POSTGRES_URL_NON_POOLING` points at anything other than a known
 * local host (`localhost`, `127.0.0.1`, `::1`, `postgres`, `db`).
 *
 * Reuses `classifyDbUrl()` from scripts/lib/db-target.ts so this layer
 * stays aligned with the integration-test safety guard and the per-script
 * `assertSafeProdWrite()` / `confirmProdWrite()` gates already in the repo.
 *
 * No bypass flag. For prod schema rollouts, use `prisma migrate deploy`
 * (forward-only, never resets) — that command is NOT wrapped because it's
 * not destructive.
 *
 * Usage (via npm scripts):
 *   npm run db:migrate:dev   -- --name <migration_name>
 *   npm run db:migrate:reset
 *   npm run db:push:reset
 *
 * Direct invocation: `npx tsx scripts/safe-prisma.ts <prisma-subcommand> ...`
 *
 * PLAYBOOK pointer: Rule 0.5 (Credential Access Protocol — destructive DB
 * ops). Direct `npx prisma migrate dev` / `migrate reset` / `db push
 * --force-reset` invocations bypass this wrapper — those forms must go
 * through these npm scripts. Linted via PLAYBOOK reviewer attention until
 * an alias-shim is justified.
 */

import { spawnSync } from "node:child_process";
import { classifyDbUrl } from "./lib/db-target";

const DESTRUCTIVE_SUBCOMMANDS = [
  ["migrate", "dev"],
  ["migrate", "reset"],
  ["db", "push", "--force-reset"],
] as const;

export function describeCommand(args: readonly string[]): string {
  return `prisma ${args.join(" ")}`;
}

/**
 * True when the args invoke one of the three destructive Prisma subcommands
 * this wrapper is responsible for gating: `migrate dev`, `migrate reset`, or
 * `db push --force-reset`. Order matters for the first two; the `--force-reset`
 * flag can appear anywhere after `db push`.
 */
export function isDestructive(args: readonly string[]): boolean {
  if (args[0] === "migrate" && args[1] === "dev") return true;
  if (args[0] === "migrate" && args[1] === "reset") return true;
  if (args[0] === "db" && args[1] === "push" && args.includes("--force-reset")) return true;
  return false;
}

// Only run main() when invoked as a CLI, not when imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("safe-prisma.ts");

function main(): never {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("safe-prisma: expected a Prisma subcommand (e.g. 'migrate dev'). Aborting.");
    process.exit(2);
  }

  if (!isDestructive(args)) {
    console.error(
      `safe-prisma: \`${describeCommand(args)}\` is not on the destructive-command list.\n` +
        `This wrapper only fronts \`migrate dev\`, \`migrate reset\`, and \`db push --force-reset\`.\n` +
        `For other Prisma commands, invoke prisma directly: \`npx prisma ${args.join(" ")}\``,
    );
    process.exit(2);
  }

  const poolUrl = process.env.POSTGRES_PRISMA_URL;
  const directUrl = process.env.POSTGRES_URL_NON_POOLING;

  const pool = classifyDbUrl(poolUrl);
  const direct = classifyDbUrl(directUrl);

  const allLocal = pool.target === "local" && direct.target === "local";

  if (!allLocal) {
    console.error("");
    console.error("  ╔════════════════════════════════════════════════════════════════════╗");
    console.error("  ║  ⚠  REFUSED — destructive Prisma command against a non-local DB    ║");
    console.error("  ╚════════════════════════════════════════════════════════════════════╝");
    console.error(`    command:               ${describeCommand(args)}`);
    console.error(`    POSTGRES_PRISMA_URL:   ${pool.redacted || "(unset)"} → ${pool.target}${pool.hostname ? ` (${pool.hostname})` : ""}`);
    console.error(`    POSTGRES_URL_NON_POOLING: ${direct.redacted || "(unset)"} → ${direct.target}${direct.hostname ? ` (${direct.hostname})` : ""}`);
    console.error("");
    console.error("    This command would reset or destroy the database at the URL above.");
    console.error("    Both POSTGRES_PRISMA_URL and POSTGRES_URL_NON_POOLING must point at a");
    console.error("    local host (localhost, 127.0.0.1, ::1, postgres, db).");
    console.error("");
    console.error("    If you want to apply a schema change to a remote DB, use the");
    console.error("    forward-only path — that command is safe and is NOT wrapped:");
    console.error("");
    console.error("      npx prisma migrate deploy");
    console.error("");
    console.error("    (Triggered by 2026-05-10 near-miss; see PLAYBOOK Rule 0.5.)");
    console.error("");
    process.exit(1);
  }

  console.log(
    `safe-prisma: ${describeCommand(args)} → both URLs are local ` +
      `(${pool.hostname}/${pool.database}, ${direct.hostname}/${direct.database}). Proceeding.\n`,
  );

  const result = spawnSync("npx", ["prisma", ...args], { stdio: "inherit" });
  if (result.error) {
    console.error(`safe-prisma: failed to spawn prisma — ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (isMain) {
  main();
}
