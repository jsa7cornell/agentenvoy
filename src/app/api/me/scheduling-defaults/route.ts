/**
 * Lightweight writer for the four fields captured by the "primary link
 * setup" guided flow on the welcome page:
 *   - businessHoursStart / businessHoursEnd (integer hour 0–24)
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
 * GET  → { businessHoursStart, businessHoursEnd, defaultDuration,
 *          bufferMinutes, meetSlug }
 * POST { businessHoursStart?, businessHoursEnd?, defaultDuration?,
 *        bufferMinutes? } → echoes the merged values.
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
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true, meetSlug: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const e = prefs.explicit ?? {};
  return NextResponse.json({
    businessHoursStart: e.businessHoursStart ?? 9,
    businessHoursEnd: e.businessHoursEnd ?? 17,
    defaultDuration: e.defaultDuration ?? 30,
    bufferMinutes: e.bufferMinutes ?? 0,
    meetSlug: user.meetSlug ?? null,
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

  const bhs = body.businessHoursStart !== undefined ? parseHour(body.businessHoursStart) : undefined;
  const bhe = body.businessHoursEnd !== undefined ? parseHour(body.businessHoursEnd) : undefined;
  const dur = body.defaultDuration !== undefined ? parseDuration(body.defaultDuration) : undefined;
  const buf = body.bufferMinutes !== undefined ? parseBuffer(body.bufferMinutes) : undefined;

  if (bhs === undefined && bhe === undefined && dur === undefined && buf === undefined) {
    return NextResponse.json(
      { error: "No recognized fields in payload" },
      { status: 400 },
    );
  }
  if (bhs !== undefined && bhe !== undefined && bhs >= bhe) {
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
    ...(dur !== undefined ? { defaultDuration: dur } : {}),
    ...(buf !== undefined ? { bufferMinutes: buf } : {}),
  };
  const nextPrefs: UserPreferences = { ...prefs, explicit: nextExplicit };

  await prisma.user.update({
    where: { id: session.user.id },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });

  // Hour-range changes affect the deterministic scoring window; invalidate.
  if (bhs !== undefined || bhe !== undefined) {
    await invalidateSchedule(session.user.id);
  }

  return NextResponse.json({
    businessHoursStart: nextExplicit.businessHoursStart,
    businessHoursEnd: nextExplicit.businessHoursEnd,
    defaultDuration: nextExplicit.defaultDuration,
    bufferMinutes: nextExplicit.bufferMinutes,
    meetSlug: current.meetSlug ?? null,
  });
}
