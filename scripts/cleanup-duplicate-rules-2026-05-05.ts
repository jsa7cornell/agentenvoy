/**
 * One-off cleanup: dedupe John's structurally-identical "Protect next Tuesday
 * all day" rules in production.
 *
 * Background: 2026-05-05 ground bug. The composer fired twice for the same
 * user turn and wrote two structurally-identical AvailabilityPreference rows
 * (rule_n99rrkp4 at 15:12, rule_u3us42kr at 16:20 — same originalText, same
 * dates, same action). PR fix/rule-compiler-and-write-time-integrity adds
 * write-time dedupe at handleUpdateAvailabilityRule, but the duplicate rows
 * already in prod must be cleaned up by hand.
 *
 * Per Rule 0.5 / db-target.ts, this script uses confirmProdWrite — running
 * against prod requires John to type the database name, not me.
 *
 * Strategy: for each (action, type, effectiveDate, expiryDate, timeStart,
 * timeEnd, daysOfWeek, originalText) shape with >1 active rows, keep the
 * earliest by createdAt, mark the rest as status="expired" (non-destructive).
 *
 * USAGE (John runs this himself):
 *
 *   cd "/Users/ja/AI Brain/agentenvoy/app"
 *   eval $(op signin)
 *   op run --env-file=.env.production -- npx tsx scripts/cleanup-duplicate-rules-2026-05-05.ts
 *
 * Then type the prod database name when prompted to confirm. The script is
 * idempotent — running twice just no-ops on the second pass.
 *
 * Safety:
 *   - DRY-RUN by default. Pass `--apply` to actually write.
 *   - Marks losers as status="expired" rather than deleting (reversible).
 *   - Refuses without an interactive confirmation typing the DB name.
 */
import { PrismaClient } from "@prisma/client";
import type { AvailabilityPreference } from "../src/lib/availability-rules";
import { confirmProdWrite } from "./lib/db-target";

const SCRIPT_NAME = "cleanup-duplicate-rules-2026-05-05";

type RuleShape = {
  action: string;
  type: string;
  effectiveDate: string | null;
  expiryDate: string | null;
  timeStart: string | null;
  timeEnd: string | null;
  daysOfWeek: string;
  originalText: string;
};

function shapeKey(r: AvailabilityPreference): string {
  const shape: RuleShape = {
    action: r.action,
    type: r.type,
    effectiveDate: r.effectiveDate ?? null,
    expiryDate: r.expiryDate ?? null,
    timeStart: r.timeStart ?? null,
    timeEnd: r.timeEnd ?? null,
    daysOfWeek: JSON.stringify(r.daysOfWeek ?? []),
    originalText: r.originalText,
  };
  return JSON.stringify(shape);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const ok = await confirmProdWrite(process.env.POSTGRES_PRISMA_URL, SCRIPT_NAME);
  if (!ok) {
    console.error(`[${SCRIPT_NAME}] aborted at confirm gate.`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, preferences: true },
    });

    let totalDupesFound = 0;
    let totalUsersWithDupes = 0;

    for (const user of users) {
      const prefs = user.preferences as { explicit?: { structuredRules?: AvailabilityPreference[] } } | null;
      const rules = prefs?.explicit?.structuredRules ?? [];
      if (rules.length === 0) continue;

      const groups = new Map<string, AvailabilityPreference[]>();
      for (const r of rules) {
        if (r.status !== "active") continue;
        // Bookable rules have a unique linkCode by construction — skip.
        if (r.action === "bookable") continue;
        const key = shapeKey(r);
        const arr = groups.get(key) ?? [];
        arr.push(r);
        groups.set(key, arr);
      }

      const dupesForUser: AvailabilityPreference[] = [];
      for (const [, arr] of groups) {
        if (arr.length <= 1) continue;
        // Keep the earliest-created; expire the rest.
        arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const losers = arr.slice(1);
        dupesForUser.push(...losers);
      }

      if (dupesForUser.length === 0) continue;

      totalUsersWithDupes++;
      totalDupesFound += dupesForUser.length;

      console.log(`[${SCRIPT_NAME}] user=${user.id} email=${user.email}`);
      for (const loser of dupesForUser) {
        console.log(
          `  - would expire rule ${loser.id}: action=${loser.action} ` +
            `effectiveDate=${loser.effectiveDate ?? "-"} originalText="${loser.originalText}" ` +
            `createdAt=${loser.createdAt}`,
        );
      }

      if (!apply) continue;

      // Mutate: mark losers status="expired".
      const loserIds = new Set(dupesForUser.map((l) => l.id));
      const nextRules = rules.map((r) =>
        loserIds.has(r.id) ? { ...r, status: "expired" as const } : r,
      );
      const nextExplicit = { ...(prefs?.explicit ?? {}), structuredRules: nextRules };
      const nextPrefs = { ...(prefs ?? {}), explicit: nextExplicit };

      await prisma.user.update({
        where: { id: user.id },
        data: { preferences: nextPrefs as object },
      });
      console.log(`  ✓ expired ${dupesForUser.length} duplicate rule(s) for user ${user.id}`);
    }

    console.log("");
    console.log(`[${SCRIPT_NAME}] summary:`);
    console.log(`  users with duplicates: ${totalUsersWithDupes}`);
    console.log(`  duplicate rules found: ${totalDupesFound}`);
    console.log(`  mode: ${apply ? "APPLIED" : "DRY-RUN (re-run with --apply to write)"}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
