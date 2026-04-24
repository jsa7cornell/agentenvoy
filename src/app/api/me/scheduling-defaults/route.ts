/**
 * Lightweight writer for the four fields captured by the "primary link
 * setup" guided flow on the welcome page:
 *   - businessHoursStart / businessHoursEnd (integer hour 0–24, legacy)
 *   - businessHoursStartMinutes / businessHoursEndMinutes (canonical —
 *     minute-of-day, 30-min aligned; added 2026-04-23 per proposal
 *     `2026-04-23_primary-link-config-convergence` §3.1 Path A)
 *   - defaultDuration (minutes)
 *   - bufferMinutes (minutes)
 *
 * The tuner/preferences route already covers these, but it's an
 * orchestration-heavy endpoint (rule compilation, office-hours backfill,
 * schedule invalidation). This route is a narrow, additive writer for
 * the guided flow — each POST merges into `preferences.explicit.*` and
 * invalidates the cached schedule. No rule recompile needed since we
 * only touch scalar hour/duration/buffer fields.
 *
 * GET  → both hour and minute representations. Prefers *Minutes if set,
 *        derives from hour * 60 otherwise.
 * POST accepts EITHER shape:
 *   - `businessHoursStartMinutes` + `businessHoursEndMinutes` (canonical)
 *   - `businessHoursStart` + `businessHoursEnd` (legacy, still accepted)
 * When minutes are supplied we also backfill the hour fields
 * (Math.floor(min/60)) so legacy readers keep working. When only hours
 * are supplied we backfill the minute fields (hour * 60) so the new
 * scoring path has canonical data.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

type NumOrUndef = number | undefined;

function parseHour(v: unknown): NumOrUndef {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.trunc(v);
  if (n < 0 || n > 24) return undefined;
  return n;
}

/** Minute-of-day, 0–1440, must be 30-min aligned. */
function parseMinuteOfDay(v: unknown): NumOrUndef {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.trunc(v);
  if (n < 0 || n > 1440) return undefined;
  if (n % 30 !== 0) return undefined;
  return n;
}

function parseDuration(v: unknown): NumOrUndef {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const allowed = [15, 30, 45, 60, 90];
  return allowed.includes(v) ? v : undefined;
}

function parseBuffer(v: unknown): NumOrUndef {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const allowed = [0, 5, 10, 15, 30];
  return allowed.includes(v) ? v : undefined;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [user, linkCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { preferences: true, meetSlug: true },
    }),
    prisma.negotiationLink.count({ where: { userId: session.user.id } }),
  ]);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const e = prefs.explicit ?? {};
  // Canonical minutes; fall back to hour*60 when minutes absent (legacy
  // rows). Hour fields echoed for backward compat with existing clients.
  const bhs = e.businessHoursStart ?? 9;
  const bhe = e.businessHoursEnd ?? 17;
  const bhsMin = e.businessHoursStartMinutes ?? bhs * 60;
  const bheMin = e.businessHoursEndMinutes ?? bhe * 60;

  // Block count — structuredRules with action="block". Powers the
  // scheduling status chip (proposal 2026-04-23 §3.2 pattern a).
  const structuredRules =
    (e as { structuredRules?: Array<{ action?: string }> }).structuredRules ?? [];
  const blockCount = structuredRules.filter((r) => r.action === "block").length;

  return NextResponse.json({
    businessHoursStart: bhs,
    businessHoursEnd: bhe,
    businessHoursStartMinutes: bhsMin,
    businessHoursEndMinutes: bheMin,
    defaultDuration: e.defaultDuration ?? 30,
    bufferMinutes: e.bufferMinutes ?? 0,
    meetSlug: user.meetSlug ?? null,
    // Counts surface on the scheduling status chip.
    linkCount,
    blockCount,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Resolve hour + minute shapes. Minutes win when both are supplied.
  let bhs = body.businessHoursStart !== undefined ? parseHour(body.businessHoursStart) : undefined;
  let bhe = body.businessHoursEnd !== undefined ? parseHour(body.businessHoursEnd) : undefined;
  let bhsMin =
    body.businessHoursStartMinutes !== undefined
      ? parseMinuteOfDay(body.businessHoursStartMinutes)
      : undefined;
  let bheMin =
    body.businessHoursEndMinutes !== undefined
      ? parseMinuteOfDay(body.businessHoursEndMinutes)
      : undefined;

  // Normalize: if only one shape was supplied for a given edge, derive the
  // other. If the caller asked for invalid values (e.g. non-number), we
  // leave that edge as-supplied (undefined = no write).
  if (bhsMin !== undefined && bhs === undefined) bhs = Math.floor(bhsMin / 60);
  if (bheMin !== undefined && bhe === undefined) bhe = Math.floor(bheMin / 60);
  if (bhs !== undefined && bhsMin === undefined) bhsMin = bhs * 60;
  if (bhe !== undefined && bheMin === undefined) bheMin = bhe * 60;

  const dur = body.defaultDuration !== undefined ? parseDuration(body.defaultDuration) : undefined;
  const buf = body.bufferMinutes !== undefined ? parseBuffer(body.bufferMinutes) : undefined;

  if (
    bhs === undefined &&
    bhe === undefined &&
    bhsMin === undefined &&
    bheMin === undefined &&
    dur === undefined &&
    buf === undefined
  ) {
    return NextResponse.json(
      { error: "No recognized fields in payload" },
      { status: 400 },
    );
  }
  if (bhsMin !== undefined && bheMin !== undefined && bhsMin >= bheMin) {
    return NextResponse.json(
      { error: "businessHoursStart must be less than businessHoursEnd" },
      { status: 400 },
    );
  }

  const current = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true, meetSlug: true },
  });
  if (!current) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (current.preferences as UserPreferences | null) ?? {};
  const nextExplicit = {
    ...(prefs.explicit ?? {}),
    ...(bhs !== undefined ? { businessHoursStart: bhs } : {}),
    ...(bhe !== undefined ? { businessHoursEnd: bhe } : {}),
    ...(bhsMin !== undefined ? { businessHoursStartMinutes: bhsMin } : {}),
    ...(bheMin !== undefined ? { businessHoursEndMinutes: bheMin } : {}),
    ...(dur !== undefined ? { defaultDuration: dur } : {}),
    ...(buf !== undefined ? { bufferMinutes: buf } : {}),
  };
  const nextPrefs: UserPreferences = { ...prefs, explicit: nextExplicit };

  await prisma.user.update({
    where: { id: session.user.id },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });

  // Hour-range changes affect the deterministic scoring window; invalidate.
  if (
    bhs !== undefined ||
    bhe !== undefined ||
    bhsMin !== undefined ||
    bheMin !== undefined
  ) {
    await invalidateSchedule(session.user.id);
  }

  return NextResponse.json({
    businessHoursStart: nextExplicit.businessHoursStart,
    businessHoursEnd: nextExplicit.businessHoursEnd,
    businessHoursStartMinutes: nextExplicit.businessHoursStartMinutes,
    businessHoursEndMinutes: nextExplicit.businessHoursEndMinutes,
    defaultDuration: nextExplicit.defaultDuration,
    bufferMinutes: nextExplicit.bufferMinutes,
    meetSlug: current.meetSlug ?? null,
  });
}
