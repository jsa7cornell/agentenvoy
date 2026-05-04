/**
 * Backfill V1.5 posture fields onto all existing variance NegotiationLinks.
 *
 * For every link whose `parameters` JSON is missing `hoursStartMinutes`, this
 * script snapshots the owning user's current Primary posture (via
 * `snapshotPostureFromUser`) and presence-merges it into the link's parameters
 * using `applyCreateEdits`. This makes every variance link "complete by
 * construction" so `getLinkPosture` stops throwing for these rows.
 *
 * Safety:
 *  - Presence-based merge: never overwrites fields the link already has.
 *  - Read-then-write per link: no bulk UPDATE so a per-row failure leaves
 *    other links untouched.
 *  - Dry-run mode (default): prints what would change without writing.
 *  - Pass --write to commit.
 *
 * Usage:
 *   npx tsx scripts/backfill-link-posture.ts           # dry-run
 *   npx tsx scripts/backfill-link-posture.ts --write   # commit
 *
 * See proposal 2026-05-02_per-link-config-storage-and-scoring-link-scope §2.2.
 */

import { PrismaClient } from "@prisma/client";
import { confirmProdWrite } from "./lib/db-target";

// Inline the posture snapshot logic to avoid Next.js path aliases in this
// plain tsx script. Mirror snapshotPostureFromUser from lib/links/create.ts.

const prisma = new PrismaClient();
const isDryRun = !process.argv.includes("--write");

if (isDryRun) {
  console.log("[backfill-link-posture] DRY RUN — pass --write to commit changes");
}

const DEFAULT_HOURS_START_MINUTES = 9 * 60;
const DEFAULT_HOURS_END_MINUTES = 18 * 60;
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_BUFFER_MINUTES = 0;
const DEFAULT_FORMAT = "video";
const DEFAULT_EVENINGS_POSTURE = "protected";
const DEFAULT_DAYS_OF_WEEK = [1, 2, 3, 4, 5];

function snapshotFromPrefs(prefs: Record<string, unknown>) {
  const explicit = (prefs.explicit as Record<string, unknown> | undefined) ?? {};
  const compiledRaw = (prefs as { compiled?: unknown }).compiled;
  const compiled =
    compiledRaw && typeof compiledRaw === "object"
      ? (compiledRaw as Record<string, unknown>)
      : null;

  const hoursStartMinutes =
    (explicit.businessHoursStartMinutes as number | undefined) ??
    (typeof explicit.businessHoursStart === "number"
      ? (explicit.businessHoursStart as number) * 60
      : DEFAULT_HOURS_START_MINUTES);

  const hoursEndMinutes =
    (explicit.businessHoursEndMinutes as number | undefined) ??
    (typeof explicit.businessHoursEnd === "number"
      ? (explicit.businessHoursEnd as number) * 60
      : DEFAULT_HOURS_END_MINUTES);

  return {
    hoursStartMinutes,
    hoursEndMinutes,
    daysOfWeek: DEFAULT_DAYS_OF_WEEK,
    duration: (explicit.defaultDuration as number | undefined) ?? DEFAULT_DURATION_MINUTES,
    bufferMinutes: (explicit.bufferMinutes as number | undefined) ?? DEFAULT_BUFFER_MINUTES,
    format: DEFAULT_FORMAT,
    eveningsPosture: DEFAULT_EVENINGS_POSTURE,
    compiled: compiled
      ? {
          buffers: (compiled.buffers as unknown[]) ?? [],
          priorityBuckets: (compiled.priorityBuckets as unknown[]) ?? [],
          allowWindows: (compiled.allowWindows as unknown[]) ?? [],
          ambiguities: (compiled.ambiguities as unknown[]) ?? [],
        }
      : { buffers: [], priorityBuckets: [], allowWindows: [], ambiguities: [] },
  };
}

async function main() {
  // Prod-write confirm gate. Dry-run reads only — no confirm needed.
  // --write against a remote DB requires retyping the database name to
  // confirm. Local DBs proceed without prompting. See post-mortem
  // 2026-05-04 §9 (audit of connection-string-bearing scripts).
  if (!isDryRun) {
    const url =
      process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_PRISMA_URL;
    const ok = await confirmProdWrite(url, "backfill-link-posture");
    if (!ok) {
      console.error("[backfill-link-posture] aborted by user — no rows changed.");
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  // Fetch all variance links (type != "primary") with their owner's preferences.
  const links = await prisma.negotiationLink.findMany({
    where: { type: { not: "primary" } },
    select: {
      id: true,
      slug: true,
      type: true,
      parameters: true,
      user: { select: { id: true, preferences: true } },
    },
  });

  console.log(`[backfill-link-posture] Found ${links.length} variance links`);

  let alreadyComplete = 0;
  let willBackfill = 0;
  let errors = 0;

  for (const link of links) {
    const existing = (link.parameters as Record<string, unknown>) ?? {};

    // Skip links that already have hoursStartMinutes — they're complete.
    if ("hoursStartMinutes" in existing) {
      alreadyComplete++;
      continue;
    }

    const userPrefs = (link.user.preferences as Record<string, unknown>) ?? {};
    const snapshot = snapshotFromPrefs(userPrefs);

    // Presence-based merge: only add fields that are absent in the link.
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(snapshot)) {
      if (!(key in merged)) {
        merged[key] = value;
      }
    }

    willBackfill++;
    console.log(
      `  [${isDryRun ? "DRY" : "WRITE"}] ${link.slug} (${link.id}) — adding posture: ` +
        `hours=${snapshot.hoursStartMinutes}–${snapshot.hoursEndMinutes}min, ` +
        `duration=${snapshot.duration}, buffer=${snapshot.bufferMinutes}`
    );

    if (!isDryRun) {
      try {
        await prisma.negotiationLink.update({
          where: { id: link.id },
          data: { parameters: merged },
        });
      } catch (err) {
        console.error(`  ERROR updating ${link.id}:`, err);
        errors++;
      }
    }
  }

  console.log(
    `\n[backfill-link-posture] Summary: ` +
      `${alreadyComplete} already complete, ` +
      `${willBackfill} ${isDryRun ? "would be backfilled" : "backfilled"}, ` +
      `${errors} errors`
  );

  if (isDryRun && willBackfill > 0) {
    console.log("\nRun with --write to commit changes.");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
