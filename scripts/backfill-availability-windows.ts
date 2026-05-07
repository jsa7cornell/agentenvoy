/**
 * Backfill PR-B canvas collapse — convert flat `hoursStartMinutes`,
 * `hoursEndMinutes`, `daysOfWeek` on variance links to the canonical
 * `availability: AvailabilityWindow[]` shape.
 *
 * Also detects and clears the legacy `availability: AvailabilitySpec` object
 * (the pre-PR-B shape where `availability` was an object with `expand`/
 * `restrictToDays` etc.). These are archived to a separate JSON file before
 * removal so nothing is silently lost.
 *
 * Three passes:
 *  1. Links with no `availability` field and flat canvas fields present →
 *     add `availability: [{ days, startMinutes, endMinutes }]`.
 *  2. Links with `availability` as a plain OBJECT (old AvailabilitySpec) →
 *     archive the value, then derive and write `availability[]` from flat
 *     fields (or default Mon–Fri 9–18 if flat fields also absent).
 *  3. Links already with `availability` as an ARRAY → skip (already done).
 *
 * Safety:
 *  - Dry-run by default. Pass --write to commit.
 *  - Per-row reads + writes (no bulk UPDATE). A per-row failure leaves
 *    other rows untouched.
 *  - Prod-write confirmation gate (via confirmProdWrite) matches Rule 0.5.
 *
 * Usage:
 *   npx tsx scripts/backfill-availability-windows.ts           # dry-run
 *   npx tsx scripts/backfill-availability-windows.ts --write   # commit
 *
 * See proposal 2026-05-06_link-config-canonical-model-and-unified-edit PR-B.
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import { confirmProdWrite } from "./lib/db-target";

const prisma = new PrismaClient();
const isDryRun = !process.argv.includes("--write");

if (isDryRun) {
  console.log("[backfill-availability-windows] DRY RUN — pass --write to commit changes");
}

const DEFAULT_HOURS_START_MINUTES = 9 * 60;  // 540
const DEFAULT_HOURS_END_MINUTES = 18 * 60;   // 1080
const DEFAULT_DAYS_OF_WEEK = [1, 2, 3, 4, 5];

interface AvailabilityWindow {
  days: number[];
  startMinutes: number;
  endMinutes: number;
}

function buildWindowFromFlat(params: Record<string, unknown>): AvailabilityWindow {
  return {
    days: Array.isArray(params.daysOfWeek)
      ? (params.daysOfWeek as number[])
      : DEFAULT_DAYS_OF_WEEK,
    startMinutes: typeof params.hoursStartMinutes === "number"
      ? params.hoursStartMinutes
      : DEFAULT_HOURS_START_MINUTES,
    endMinutes: typeof params.hoursEndMinutes === "number"
      ? params.hoursEndMinutes
      : DEFAULT_HOURS_END_MINUTES,
  };
}

type PassResult = "already_done" | "no_canvas" | "flat_promoted" | "spec_replaced" | "error";

async function main() {
  if (!isDryRun) {
    const url = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_PRISMA_URL;
    const ok = await confirmProdWrite(url, "backfill-availability-windows");
    if (!ok) {
      console.error("[backfill-availability-windows] aborted — no rows changed.");
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  const links = await prisma.negotiationLink.findMany({
    where: { type: { not: "primary" } },
    select: { id: true, slug: true, parameters: true },
  });

  console.log(`[backfill-availability-windows] Found ${links.length} variance links`);

  const counts: Record<PassResult, number> = {
    already_done: 0,
    no_canvas: 0,
    flat_promoted: 0,
    spec_replaced: 0,
    error: 0,
  };

  const legacySpecArchive: Array<{ linkId: string; slug: string; legacySpec: unknown }> = [];

  for (const link of links) {
    const params = (link.parameters as Record<string, unknown>) ?? {};
    const existing = params.availability;

    let result: PassResult;

    if (Array.isArray(existing)) {
      // Pass 3: already an array — skip
      result = "already_done";
    } else if (existing !== null && existing !== undefined && typeof existing === "object") {
      // Pass 2: old AvailabilitySpec object — archive and replace
      legacySpecArchive.push({ linkId: link.id, slug: link.slug, legacySpec: existing });
      const window = buildWindowFromFlat(params);

      console.log(
        `  [${isDryRun ? "DRY" : "WRITE"}] SPEC→ARRAY ${link.slug} (${link.id}) — ` +
        `archived old spec, will set availability=[{days:${window.days},start:${window.startMinutes},end:${window.endMinutes}}]`
      );

      if (!isDryRun) {
        try {
          await prisma.negotiationLink.update({
            where: { id: link.id },
            data: { parameters: { ...params, availability: [window] } },
          });
        } catch (err) {
          console.error(`  ERROR updating ${link.id}:`, err);
          counts.error++;
          continue;
        }
      }
      result = "spec_replaced";
    } else if (!("hoursStartMinutes" in params) && !("hoursEndMinutes" in params)) {
      // No canvas at all — link should have been caught by backfill-link-posture first
      result = "no_canvas";
      console.log(
        `  [SKIP] ${link.slug} (${link.id}) — no canvas fields; run backfill-link-posture first`
      );
    } else {
      // Pass 1: flat canvas present, no availability[] yet — promote
      const window = buildWindowFromFlat(params);

      console.log(
        `  [${isDryRun ? "DRY" : "WRITE"}] PROMOTE ${link.slug} (${link.id}) — ` +
        `days=${window.days}, start=${window.startMinutes}, end=${window.endMinutes}`
      );

      if (!isDryRun) {
        try {
          await prisma.negotiationLink.update({
            where: { id: link.id },
            data: { parameters: { ...params, availability: [window] } },
          });
        } catch (err) {
          console.error(`  ERROR updating ${link.id}:`, err);
          counts.error++;
          continue;
        }
      }
      result = "flat_promoted";
    }

    counts[result]++;
  }

  // Archive legacy AvailabilitySpec values to disk before they're gone
  if (legacySpecArchive.length > 0) {
    const archivePath = path.join(__dirname, "backfill-availability-spec-archive.json");
    fs.writeFileSync(archivePath, JSON.stringify(legacySpecArchive, null, 2));
    console.log(`\n[backfill-availability-windows] Archived ${legacySpecArchive.length} legacy AvailabilitySpec values to ${archivePath}`);
  }

  console.log(
    `\n[backfill-availability-windows] Summary:\n` +
    `  ${counts.already_done} already done (availability[] present)\n` +
    `  ${counts.flat_promoted} ${isDryRun ? "would be" : ""} promoted from flat fields\n` +
    `  ${counts.spec_replaced} ${isDryRun ? "would be" : ""} replaced from old AvailabilitySpec\n` +
    `  ${counts.no_canvas} skipped (no canvas — run backfill-link-posture first)\n` +
    `  ${counts.error} errors`
  );

  if (isDryRun && (counts.flat_promoted + counts.spec_replaced) > 0) {
    console.log("\nRun with --write to commit changes.");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
