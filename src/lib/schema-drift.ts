/**
 * Schema drift detector.
 *
 * Compares the column set Prisma expects (from DMMF — generated at build
 * time from schema.prisma) against the column set actually present in
 * Postgres (via information_schema). Reports every model whose expected
 * columns aren't all in the DB.
 *
 * Motivation: we've been bitten twice by shipping a schema.prisma change
 * without running the matching migration in Supabase (guestTimezone on
 * 2026-04-15, welcomeEmailSentAt on 2026-04-17). Both times prod broke
 * silently because Prisma generates queries that SELECT every column —
 * and a missing column is a SQL error on every adapter call. This
 * detector catches the same failure mode within one cron tick.
 *
 * Generic by design: zero per-column maintenance. Every schema change
 * automatically picks up drift detection because DMMF re-generates.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface ModelDriftReport {
  /** Prisma model name (e.g. "User"). */
  model: string;
  /** Actual Postgres table name — honors @@map. */
  table: string;
  /** True when the entire table is missing. */
  tableMissing: boolean;
  /** Columns Prisma expects but Postgres doesn't have. Failure condition. */
  missing: string[];
  /** Columns Postgres has that Prisma doesn't expect. Informational only —
   *  happens naturally between "remove field from schema" and "DROP COLUMN". */
  extra: string[];
}

export interface SchemaDriftReport {
  /** True iff no model has missing columns or missing tables. */
  ok: boolean;
  checkedAt: string;
  models: ModelDriftReport[];
  /** Convenience — the subset of models with `tableMissing || missing.length > 0`. */
  affected: ModelDriftReport[];
}

/**
 * Run the drift check against the current DB. Pure read. Completes in
 * <100ms for our model count even without indexing (information_schema
 * queries are cheap).
 */
export async function checkSchemaDrift(): Promise<SchemaDriftReport> {
  const models = Prisma.dmmf.datamodel.models;

  // One query per model — these are lightweight. Running in parallel keeps
  // the total wall time to a single round-trip's worth.
  const modelReports = await Promise.all(
    models.map(async (model): Promise<ModelDriftReport> => {
      const table = model.dbName || model.name;
      // Only scalar and enum fields land as real columns. Relations, objects,
      // and unsupported types don't.
      const expectedColumns = model.fields
        .filter((f) => f.kind === "scalar" || f.kind === "enum")
        .map((f) => f.dbName || f.name);

      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
      `;
      const actualColumns = rows.map((r) => r.column_name);

      // No rows at all = the table itself is missing. Everything else is a
      // derived concept.
      if (actualColumns.length === 0) {
        return {
          model: model.name,
          table,
          tableMissing: true,
          missing: expectedColumns,
          extra: [],
        };
      }

      const actualSet = new Set(actualColumns);
      const expectedSet = new Set(expectedColumns);
      return {
        model: model.name,
        table,
        tableMissing: false,
        missing: expectedColumns.filter((c) => !actualSet.has(c)),
        extra: actualColumns.filter((c) => !expectedSet.has(c)),
      };
    }),
  );

  const affected = modelReports.filter(
    (r) => r.tableMissing || r.missing.length > 0,
  );

  return {
    ok: affected.length === 0,
    checkedAt: new Date().toISOString(),
    models: modelReports,
    affected,
  };
}

/** Render a short plain-text summary suitable for alert emails + logs. */
export function formatDriftSummary(report: SchemaDriftReport): string {
  if (report.ok) return "Schema OK — no drift detected.";
  const lines = report.affected.map((m) => {
    if (m.tableMissing) return `${m.table}: ENTIRE TABLE MISSING (expected ${m.missing.length} columns)`;
    return `${m.table}: missing ${m.missing.join(", ")}`;
  });
  return `Schema drift across ${report.affected.length} model(s):\n${lines.join("\n")}`;
}
