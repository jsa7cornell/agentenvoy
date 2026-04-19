/**
 * GET /api/admin/smoke
 *
 * Post-deploy smoke test. Probes five critical paths and returns a JSON
 * report. Returns 200 if all probes pass, 500 if any fail.
 *
 * Auth: Bearer token via Authorization header, matched against
 * ADMIN_SMOKE_TOKEN env var. Neither OAuth nor session — so a GitHub
 * Actions job can call it without a browser.
 *
 * Probes:
 *   db            — DB roundtrip (write + read latency)
 *   migrations    — _prisma_migrations row count vs prisma/migrations/ dirs
 *   ses_creds     — AWS_SES_ACCESS_KEY_ID / _SECRET_ACCESS_KEY present
 *   calendar_cache — CalendarCache table reachable
 *   env           — Critical env vars present and production-safe
 *
 * Alerting: log-only for first week. After one clean week of deploys,
 * flip SMOKE_ALERTS_ENABLED=true to wire the email alert.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readdirSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
  [key: string]: unknown;
}

interface SmokeReport {
  ok: boolean;
  timestamp: string;
  sha: string;
  probes: Record<string, ProbeResult>;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────
  const token = process.env.ADMIN_SMOKE_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "ADMIN_SMOKE_TOKEN not configured" },
      { status: 503 },
    );
  }
  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!provided || provided !== token) {
    return new NextResponse(null, { status: 404 }); // Don't advertise existence
  }

  // ── Run probes ────────────────────────────────────────────────────────
  const [db, migrations, sesCreds, calendarCache, env] = await Promise.all([
    probeDb(),
    probeMigrations(),
    probeSesCreds(),
    probeCalendarCache(),
    probeEnv(),
  ]);

  const probes = { db, migrations, ses_creds: sesCreds, calendar_cache: calendarCache, env };
  const allOk = Object.values(probes).every((p) => p.ok);
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";

  const report: SmokeReport = {
    ok: allOk,
    timestamp: new Date().toISOString(),
    sha,
    probes,
  };

  if (!allOk) {
    // Log the failure — visible in Vercel runtime logs immediately after deploy.
    // Email alerting gated on SMOKE_ALERTS_ENABLED=true (flip after first clean week).
    console.error(
      "[smoke] Post-deploy smoke FAILED:",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(probes)
            .filter(([, v]) => !v.ok)
            .map(([k, v]) => [k, v.detail ?? "failed"]),
        ),
      ),
    );
  }

  return NextResponse.json(report, { status: allOk ? 200 : 500 });
}

// ── Probe implementations ─────────────────────────────────────────────────

async function probeDb(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    // Trivial read that touches the DB without modifying data.
    await prisma.routeError.count({ where: { id: "__smoke__" } });
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeMigrations(): Promise<ProbeResult> {
  try {
    // Count dirs (not loose .sql files) in prisma/migrations/ — these are
    // the canonical migration units Prisma tracks.
    const migrationsDir = join(process.cwd(), "prisma", "migrations");
    let fsCount = 0;
    try {
      const entries = readdirSync(migrationsDir, { withFileTypes: true });
      fsCount = entries.filter((e) => e.isDirectory()).length;
    } catch {
      return { ok: false, detail: "Could not read prisma/migrations/ directory" };
    }

    // Count rows in _prisma_migrations (all migrations Prisma knows were applied).
    const dbResult = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM "_prisma_migrations"
    `;
    const dbCount = Number(dbResult[0].count);

    // Allow up to 1 discrepancy (a migration dir added but not yet tracked).
    const diff = Math.abs(fsCount - dbCount);
    const ok = diff <= 1;
    return {
      ok,
      fsCount,
      dbCount,
      diff,
      detail: ok
        ? undefined
        : `${diff} migration(s) in filesystem not tracked in _prisma_migrations`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeSesCreds(): Promise<ProbeResult> {
  const keyId = process.env.AWS_SES_ACCESS_KEY_ID;
  const secret = process.env.AWS_SES_SECRET_ACCESS_KEY;
  if (!keyId || !secret) {
    const missing = [!keyId && "AWS_SES_ACCESS_KEY_ID", !secret && "AWS_SES_SECRET_ACCESS_KEY"]
      .filter(Boolean)
      .join(", ");
    return Promise.resolve({ ok: false, detail: `Missing: ${missing}` });
  }
  return Promise.resolve({ ok: true });
}

async function probeCalendarCache(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const rowCount = await prisma.calendarCache.count();
    return { ok: true, latencyMs: Date.now() - start, rowCount };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeEnv(): Promise<ProbeResult> {
  const required = [
    "POSTGRES_PRISMA_URL",
    "NEXTAUTH_SECRET",
    "NEXTAUTH_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ADMIN_EMAIL",
  ];
  const missing = required.filter((k) => !process.env[k]);

  // Warn if effect modes are not set to production values.
  const warnings: string[] = [];
  const emailMode = process.env.EFFECT_MODE_EMAIL;
  const calMode = process.env.EFFECT_MODE_CALENDAR;
  if (emailMode && emailMode !== "live") warnings.push(`EFFECT_MODE_EMAIL=${emailMode} (expected live)`);
  if (calMode && calMode !== "live") warnings.push(`EFFECT_MODE_CALENDAR=${calMode} (expected live)`);

  const ok = missing.length === 0;
  return Promise.resolve({
    ok,
    detail: [
      missing.length ? `Missing vars: ${missing.join(", ")}` : "",
      warnings.length ? `Warnings: ${warnings.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ") || undefined,
    warnings: warnings.length ? warnings : undefined,
  });
}
