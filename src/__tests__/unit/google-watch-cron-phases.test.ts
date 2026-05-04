/**
 * Unit tests for cron/daily phases 8 (renewal), 9 (cleanup), and 10
 * (push-watchdog). Proposal 2026-05-04_google-calendar-push-notifications §6a.
 *
 * We exercise the phases via the full GET handler and assert on both the
 * response shape and the underlying mock call patterns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() for all factory closures
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  listExpiringChannels: vi.fn().mockResolvedValue([]),
  renewWatchChannel: vi.fn().mockResolvedValue(undefined),
  stopWatchChannel: vi.fn().mockResolvedValue(undefined),
  incrementalSyncForUser: vi.fn().mockResolvedValue(false),
  invalidateSchedule: vi.fn().mockResolvedValue(undefined),
  isDeadGoogleAuthError: vi.fn().mockReturnValue(false),
  clearGoogleRefreshToken: vi.fn().mockResolvedValue(undefined),
  getGoogleCalendarClient: vi.fn().mockResolvedValue({}),
  prisma: {
    negotiationSession: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    account: { findMany: vi.fn().mockResolvedValue([]) },
    hold: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    message: { create: vi.fn().mockResolvedValue({}) },
    sideEffectLog: { findFirst: vi.fn().mockResolvedValue(null) },
    calendarWatchChannel: { findMany: vi.fn().mockResolvedValue([]) },
    calendarCache: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/calendar", () => ({
  deleteCalendarEvent: vi.fn(),
  getCalendarEventStatus: vi.fn().mockResolvedValue("exists"),
  isDeadGoogleAuthError: mocks.isDeadGoogleAuthError,
  clearGoogleRefreshToken: mocks.clearGoogleRefreshToken,
  getGoogleCalendarClient: mocks.getGoogleCalendarClient,
  incrementalSyncForUser: mocks.incrementalSyncForUser,
  invalidateSchedule: mocks.invalidateSchedule,
}));

vi.mock("@/lib/google-watch", () => ({
  listExpiringChannels: mocks.listExpiringChannels,
  renewWatchChannel: mocks.renewWatchChannel,
  stopWatchChannel: mocks.stopWatchChannel,
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

vi.mock("@/lib/cancel-pipeline", () => ({ cancelSession: vi.fn() }));
vi.mock("@/lib/schema-drift", () => ({
  checkSchemaDrift: vi.fn().mockResolvedValue({ drifted: false, tables: [] }),
  formatDriftSummary: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/env-drift", () => ({
  checkEnvDrift: vi.fn().mockResolvedValue({ drifted: false }),
  formatEnvDriftSummary: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/route-error", () => ({ logRouteError: vi.fn() }));
vi.mock("@/lib/emails/dev-stats", () => ({ buildDevStatsEmail: vi.fn().mockReturnValue("") }));
vi.mock("@/lib/emails/dev-stats-gather", () => ({
  gatherDevStats: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/emails/meeting-reminder", () => ({
  buildMeetingReminderEmail: vi.fn().mockResolvedValue(""),
}));
vi.mock("@/lib/format-duration", () => ({ formatDuration: vi.fn().mockReturnValue("1h") }));
vi.mock("@/lib/log-recipients", () => ({
  getLogRecipients: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/side-effects/dispatcher", () => ({
  dispatch: vi.fn().mockResolvedValue({ status: "ok" }),
}));

// ---------------------------------------------------------------------------

import { GET } from "@/app/api/cron/daily/route";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/cron/daily");
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default return values after clearAllMocks resets them
  mocks.listExpiringChannels.mockResolvedValue([]);
  mocks.renewWatchChannel.mockResolvedValue(undefined);
  mocks.stopWatchChannel.mockResolvedValue(undefined);
  mocks.incrementalSyncForUser.mockResolvedValue(false);
  mocks.invalidateSchedule.mockResolvedValue(undefined);
  mocks.isDeadGoogleAuthError.mockReturnValue(false);
  mocks.getGoogleCalendarClient.mockResolvedValue({});
  mocks.prisma.negotiationSession.findMany.mockResolvedValue([]);
  mocks.prisma.negotiationSession.update.mockResolvedValue({});
  mocks.prisma.account.findMany.mockResolvedValue([]);
  mocks.prisma.hold.findMany.mockResolvedValue([]);
  mocks.prisma.hold.update.mockResolvedValue({});
  mocks.prisma.message.create.mockResolvedValue({});
  mocks.prisma.sideEffectLog.findFirst.mockResolvedValue(null);
  mocks.prisma.calendarWatchChannel.findMany.mockResolvedValue([]);
  mocks.prisma.calendarCache.findMany.mockResolvedValue([]);
  mocks.prisma.user.findMany.mockResolvedValue([]);
  mocks.prisma.$queryRaw.mockResolvedValue([]);
});

describe("Phase 8 — renew Google watch channels", () => {
  it("includes watchRenewal key with correct shape in response", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body).toHaveProperty("watchRenewal");
    expect(body.watchRenewal).toMatchObject({
      checked: expect.any(Number),
      renewed: expect.any(Number),
      errors: expect.any(Array),
    });
  });

  it("calls listExpiringChannels for events (<48h) and calendarList (<96h)", async () => {
    await GET(makeRequest());
    expect(mocks.listExpiringChannels).toHaveBeenCalledWith(48 * 60 * 60 * 1000, "events");
    expect(mocks.listExpiringChannels).toHaveBeenCalledWith(96 * 60 * 60 * 1000, "calendarList");
  });

  it("calls renewWatchChannel for each expiring channel, reports count", async () => {
    const expiring = [{ channelId: "ch-1" }, { channelId: "ch-2" }];
    mocks.listExpiringChannels
      .mockResolvedValueOnce(expiring)  // events
      .mockResolvedValueOnce([]);        // calendarList

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.watchRenewal.renewed).toBe(2);
    expect(mocks.renewWatchChannel).toHaveBeenCalledWith("ch-1");
    expect(mocks.renewWatchChannel).toHaveBeenCalledWith("ch-2");
  });

  it("records errors but does not throw when renewWatchChannel fails", async () => {
    mocks.listExpiringChannels
      .mockResolvedValueOnce([{ channelId: "ch-bad" }])
      .mockResolvedValueOnce([]);
    mocks.renewWatchChannel.mockRejectedValueOnce(new Error("Google 403"));

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.watchRenewal.errors).toHaveLength(1);
    expect(body.watchRenewal.errors[0]).toContain("Google 403");
  });
});

describe("Phase 9 — cleanup dead Google watch channels", () => {
  it("includes watchCleanup key in response with correct shape", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body).toHaveProperty("watchCleanup");
    expect(body.watchCleanup).toMatchObject({
      checked: expect.any(Number),
      markedDead: expect.any(Number),
      errors: expect.any(Array),
    });
  });

  it("calls stopWatchChannel for each stale channel from the DB query", async () => {
    // The phase does a findMany with OR conditions for stale lastPingAt
    mocks.prisma.calendarWatchChannel.findMany.mockResolvedValueOnce([
      { channelId: "ch-stale-1" },
      { channelId: "ch-stale-2" },
    ]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.watchCleanup.markedDead).toBe(2);
    expect(mocks.stopWatchChannel).toHaveBeenCalledWith("ch-stale-1");
    expect(mocks.stopWatchChannel).toHaveBeenCalledWith("ch-stale-2");
  });
});

describe("Phase 10 — push-notification watchdog sweep", () => {
  it("includes watchdog key in response with correct shape", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body).toHaveProperty("watchdog");
    expect(body.watchdog).toMatchObject({
      checked: expect.any(Number),
      missedPings: expect.any(Number),
      errors: expect.any(Array),
    });
  });

  it("excludes users with no recent calendar activity (checked = 0)", async () => {
    // Suspect channel exists...
    mocks.prisma.calendarWatchChannel.findMany
      .mockResolvedValueOnce([])  // phase 9 stale query returns nothing
      .mockResolvedValueOnce([    // phase 10 suspect query
        { channelId: "ch-suspect", userId: "user-1", calendarId: "cal-1" },
      ]);
    // ...but no recent activity
    mocks.prisma.calendarCache.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.watchdog.checked).toBe(0);
    expect(mocks.incrementalSyncForUser).not.toHaveBeenCalled();
  });

  it("syncs suspect channels with recent activity, reports missed-pings when changes found", async () => {
    mocks.prisma.calendarWatchChannel.findMany
      .mockResolvedValueOnce([])  // phase 9
      .mockResolvedValueOnce([    // phase 10 suspect query
        { channelId: "ch-suspect", userId: "user-1", calendarId: "cal-1" },
      ]);
    // Recent activity exists for user-1
    mocks.prisma.calendarCache.findMany.mockResolvedValue([{ userId: "user-1" }]);
    // Sync finds real changes
    mocks.incrementalSyncForUser.mockResolvedValueOnce(true);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.watchdog.checked).toBe(1);
    expect(body.watchdog.missedPings).toBe(1);
    expect(mocks.incrementalSyncForUser).toHaveBeenCalledWith("user-1", "cal-1");
  });
});
