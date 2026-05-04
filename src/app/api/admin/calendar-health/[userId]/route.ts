/**
 * GET  /api/admin/calendar-health/[userId]
 * POST /api/admin/calendar-health/[userId]/test-ping  (handled separately below)
 *
 * Admin-only (requireAdminContext) debugging endpoint for Google Calendar push
 * notification health. Returns channel status, cache ages, and recent pings
 * for a given user. The primary "why is the picker stale?" investigation tool.
 *
 * Also handles:
 *   POST /api/admin/calendar-health/[userId]?action=test-ping
 *     Synthesizes a Google-shaped ping against the webhook handler logic
 *     (skips X-Goog-Channel-Token validation in non-production) so we can
 *     exercise the handler path without a real Google channel or ngrok.
 *
 * See proposal 2026-05-04_google-calendar-push-notifications §3h for the
 * full JSON shape and the "11pm-debuggability" rationale.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import {
  incrementalSyncForUser,
  invalidateSchedule,
  invalidateCalendarListCache,
} from "@/lib/calendar";

export const dynamic = "force-dynamic";

function channelHealth(channel: {
  active: boolean;
  expiration: Date;
  lastPingAt: Date | null;
}): "healthy" | "stale" | "expiring" | "dead" {
  if (!channel.active) return "dead";
  const now = Date.now();
  const expiresInMs = channel.expiration.getTime() - now;
  if (expiresInMs < 0) return "dead";
  if (expiresInMs < 48 * 60 * 60 * 1000) return "expiring";
  const lastPingAgoMs = channel.lastPingAt ? now - channel.lastPingAt.getTime() : null;
  if (lastPingAgoMs === null || lastPingAgoMs > 7 * 24 * 60 * 60 * 1000) return "stale";
  return "healthy";
}

export async function GET(
  req: NextRequest,
  { params }: { params: { userId: string } },
) {
  await requireAdminContext("/api/admin/calendar-health");

  const { userId } = params;

  const [channels, calendarCaches, computedSchedule, calendarListCache] =
    await Promise.all([
      prisma.calendarWatchChannel.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.calendarCache.findMany({
        where: { userId },
        select: { calendarId: true, lastSyncedAt: true },
      }),
      prisma.computedSchedule.findUnique({
        where: { userId },
        select: { computedAt: true },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).calendarListCache.findUnique({
        where: { userId },
        select: { fetchedAt: true },
      }),
    ]);

  const now = Date.now();

  const eventsLastSyncedAtPerCal: Record<string, number> = {};
  for (const c of calendarCaches) {
    eventsLastSyncedAtPerCal[c.calendarId] = now - c.lastSyncedAt.getTime();
  }

  // Last 10 pings across all channels
  const recentChannels = await prisma.calendarWatchChannel.findMany({
    where: { userId },
    orderBy: { lastPingAt: { sort: "desc", nulls: "last" } },
    take: 10,
    select: {
      channelId: true,
      kind: true,
      lastPingAt: true,
      lastSyncDiffAt: true,
    },
  });

  const last10 = recentChannels
    .filter((c) => c.lastPingAt)
    .map((c) => ({
      at: c.lastPingAt!.toISOString(),
      kind: c.kind,
      channelId: c.channelId,
      foundChanges: c.lastSyncDiffAt !== null &&
        c.lastPingAt !== null &&
        c.lastSyncDiffAt >= c.lastPingAt,
    }));

  const last24hCount = channels.filter(
    (c) => c.lastPingAt && now - c.lastPingAt.getTime() < 24 * 60 * 60 * 1000,
  ).length;

  return NextResponse.json({
    userId,
    channels: channels.map((c) => ({
      channelId: c.channelId,
      kind: c.kind,
      calendarId: c.calendarId,
      active: c.active,
      expiration: c.expiration.toISOString(),
      expiresInMs: c.expiration.getTime() - now,
      lastPingAt: c.lastPingAt?.toISOString() ?? null,
      lastPingAgoMs: c.lastPingAt ? now - c.lastPingAt.getTime() : null,
      lastSyncDiffAt: c.lastSyncDiffAt?.toISOString() ?? null,
      health: channelHealth(c),
    })),
    cache: {
      calendarListAgeMs: calendarListCache
        ? now - new Date(calendarListCache.fetchedAt).getTime()
        : null,
      eventsLastSyncedAtPerCal,
      computedScheduleAgeMs: computedSchedule
        ? now - computedSchedule.computedAt.getTime()
        : null,
    },
    pings: {
      last10,
      last24hCount,
    },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { userId: string } },
) {
  await requireAdminContext("/api/admin/calendar-health");

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action !== "test-ping") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const { userId } = params;
  const body = await req.json().catch(() => ({}));
  const { calendarId, kind = "events" } = body as {
    calendarId?: string;
    kind?: string;
  };

  if (kind === "events" && !calendarId) {
    return NextResponse.json(
      { error: "calendarId required for kind=events" },
      { status: 400 },
    );
  }

  try {
    if (kind === "events" && calendarId) {
      const foundChanges = await incrementalSyncForUser(userId, calendarId);
      await invalidateSchedule(userId);
      return NextResponse.json({
        ok: true,
        kind: "events",
        calendarId,
        foundChanges,
      });
    } else if (kind === "calendarList") {
      await invalidateCalendarListCache(userId);
      return NextResponse.json({ ok: true, kind: "calendarList" });
    }
    return NextResponse.json({ error: "Unsupported kind" }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
