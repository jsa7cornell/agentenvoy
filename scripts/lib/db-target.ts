/**
 * DB target classification + confirm gates for one-off scripts.
 *
 * Background: 2026-05-04 prod-wipe incident. The integration-test path is
 * now triple-guarded (see app/src/__tests__/integration/helpers/safety.ts),
 * but `prisma/seed.ts` and `scripts/backfill-link-posture.ts` both have
 * destructive write paths against whatever URL is loaded. They're designed
 * to legitimately run against prod sometimes (one-time backfills) — so a
 * hard refuse is wrong. The right shape is "you're touching prod, are you
 * sure?" with two flavors:
 *
 *   - Non-interactive (Prisma-invoked seed): require a sentinel env var.
 *   - Interactive (tsx scripts run by hand): prompt + parse stdin.
 *
 * Both share the URL classifier; ALLOWED_HOSTS mirrors the integration
 * test guard so the two layers stay aligned.
 *
 * This file lives under `scripts/` (excluded from tsconfig per
 * tsconfig.json:25) so it can use Node-only APIs (readline, process.stdin)
 * without polluting the Next.js runtime.
 */

import { createInterface } from "node:readline/promises";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres",
  "db",
]);

export type DbTarget = "local" | "remote" | "unparseable";

/** Pure classifier — exported separately so it can be unit-tested. */
export function classifyDbUrl(rawUrl: string | undefined): {
  target: DbTarget;
  hostname: string;
  database: string;
  redacted: string;
} {
  if (!rawUrl) {
    return { target: "unparseable", hostname: "", database: "", redacted: "" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      target: "unparseable",
      hostname: "",
      database: "",
      redacted: redactUrl(rawUrl),
    };
  }
  const hostname = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\//, "").split("?")[0];
  const target: DbTarget = LOCAL_HOSTS.has(hostname) ? "local" : "remote";
  return { target, hostname, database, redacted: redactUrl(rawUrl) };
}

function redactUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

/**
 * Non-interactive gate. If the URL is remote, throws unless the sentinel
 * env var is set to "1". Use in scripts invoked by tooling (Prisma, CI)
 * where stdin prompts won't work cleanly.
 *
 * @param scriptName - shown in the error / log line for grep-ability.
 * @param sentinelEnvVar - the env var that must equal "1" to permit a
 *   remote write. Convention: `<SCRIPT>_PROD_OK=1`. The variable name
 *   itself is the documentation: anyone reading shell history sees what
 *   they're authorizing.
 */
export function assertSafeProdWrite(
  rawUrl: string | undefined,
  scriptName: string,
  sentinelEnvVar: string,
): void {
  const { target, hostname, database, redacted } = classifyDbUrl(rawUrl);

  if (target === "unparseable") {
    throw new Error(
      `[${scriptName}] REFUSED: connection URL is missing or unparseable.\n` +
        `  URL: ${redacted || "(empty)"}`,
    );
  }

  if (target === "local") {
    console.log(`[${scriptName}] target: LOCAL (${hostname}/${database}) — proceeding.`);
    return;
  }

  if (process.env[sentinelEnvVar] !== "1") {
    throw new Error(
      `[${scriptName}] REFUSED: target appears REMOTE.\n` +
        `  hostname: ${hostname}\n` +
        `  database: ${database}\n` +
        `  URL:      ${redacted}\n` +
        `\n` +
        `  This script writes to the database. Running against a remote\n` +
        `  target requires explicit consent. To proceed, re-run with:\n` +
        `    ${sentinelEnvVar}=1 <your command>\n` +
        `\n` +
        `  Setting ${sentinelEnvVar} in any .env file defeats the purpose.\n` +
        `  Set it inline on the command that needs it.`,
    );
  }

  console.log(
    `[${scriptName}] target: REMOTE (${hostname}/${database}) — ` +
      `${sentinelEnvVar}=1 set; proceeding.`,
  );
}

/**
 * Interactive gate. If the URL is remote, prints a banner + prompts the
 * user to type the literal database name to confirm. Anything else aborts.
 * Returns true on confirmation, false on abort. Caller decides what to do
 * with false (typically: process.exit(1)).
 *
 * Why retype-the-database-name and not just "yes/no": "yes" is a reflex
 * answer; typing the actual prod database name is a conscious act that
 * proves you read the banner.
 *
 * No-ops (returns true) immediately for local targets.
 */
export async function confirmProdWrite(
  rawUrl: string | undefined,
  scriptName: string,
): Promise<boolean> {
  const { target, hostname, database, redacted } = classifyDbUrl(rawUrl);

  if (target === "unparseable") {
    console.error(
      `[${scriptName}] REFUSED: connection URL is missing or unparseable.\n` +
        `  URL: ${redacted || "(empty)"}`,
    );
    return false;
  }

  if (target === "local") {
    return true;
  }

  console.error("");
  console.error("  ╔══════════════════════════════════════════════════════════════╗");
  console.error("  ║  ⚠️  REMOTE / PRODUCTION DB WRITE                             ║");
  console.error("  ╚══════════════════════════════════════════════════════════════╝");
  console.error(`    script:   ${scriptName}`);
  console.error(`    hostname: ${hostname}`);
  console.error(`    database: ${database}`);
  console.error(`    URL:      ${redacted}`);
  console.error("");
  console.error(`  To confirm, type the database name (${database}) and press Enter.`);
  console.error(`  Anything else — including "yes" — aborts.`);
  console.error("");

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("  > ")).trim();
    return answer === database;
  } finally {
    rl.close();
  }
}
