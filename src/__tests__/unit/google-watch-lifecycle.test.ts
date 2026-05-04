/**
 * Unit tests for google-watch.ts lifecycle helpers.
 * Proposal 2026-05-04_google-calendar-push-notifications §6a.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() so factory closures can reference these vars
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const googleClient = {
    events: { watch: vi.fn() },
    calendarList: { watch: vi.fn() },
    channels: { stop: vi.fn() },
  };
  return {
    prisma: {
      calendarWatchChannel: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    },
    googleClient,
    getGoogleCalendarClient: vi.fn().mockResolvedValue(googleClient),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/calendar", () => ({
  getGoogleCalendarClient: mocks.getGoogleCalendarClient,
}));

// ---------------------------------------------------------------------------

import {
  registerEventsWatch,
  registerCalendarListWatch,
  stopWatchChannel,
  stopAllWatchesForUser,
  reconcileEventsWatches,
  listExpiringChannels,
  renewWatchChannel,
} from "@/lib/google-watch";

const CHANNEL_ROW = {
  id: "row-1",
  channelId: "ch-abc",
  userId: "user-1",
  calendarId: "cal@gmail.com",
  resourceId: "res-1",
  token: "tok",
  kind: "events",
  expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  lastPingAt: null,
  lastSyncDiffAt: null,
  active: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GOOGLE_WATCH_DISABLED;
  process.env.PUBLIC_BASE_URL = "https://agentenvoy.ai";
  mocks.getGoogleCalendarClient.mockResolvedValue(mocks.googleClient);
});

describe("registerEventsWatch", () => {
  it("returns null and skips registration when GOOGLE_WATCH_DISABLED=1", async () => {
    process.env.GOOGLE_WATCH_DISABLED = "1";
    const result = await registerEventsWatch("user-1", "cal@gmail.com");
    expect(result).toBeNull();
    expect(mocks.prisma.calendarWatchChannel.findFirst).not.toHaveBeenCalled();
  });

  it("returns existing channel without calling Google if one is active", async () => {
    mocks.prisma.calendarWatchChannel.findFirst.mockResolvedValue(CHANNEL_ROW);
    const result = await registerEventsWatch("user-1", "cal@gmail.com");
    expect(result).toBe(CHANNEL_ROW);
    expect(mocks.googleClient.events.watch).not.toHaveBeenCalled();
  });

  it("registers new channel and creates DB row when no active channel exists", async () => {
    mocks.prisma.calendarWatchChannel.findFirst.mockResolvedValue(null);
    mocks.googleClient.events.watch.mockResolvedValue({
      data: { id: "ch-new", resourceId: "res-new", expiration: "9999999999000" },
    });
    mocks.prisma.calendarWatchChannel.create.mockResolvedValue({ ...CHANNEL_ROW, channelId: "ch-new" });

    const result = await registerEventsWatch("user-1", "cal@gmail.com");

    expect(mocks.googleClient.events.watch).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "cal@gmail.com",
        requestBody: expect.objectContaining({ type: "web_hook" }),
      }),
    );
    expect(mocks.prisma.calendarWatchChannel.create).toHaveBeenCalled();
    expect(result?.channelId).toBe("ch-new");
  });
});

describe("registerCalendarListWatch", () => {
  it("returns null when GOOGLE_WATCH_DISABLED=1", async () => {
    process.env.GOOGLE_WATCH_DISABLED = "1";
    expect(await registerCalendarListWatch("user-1")).toBeNull();
    expect(mocks.prisma.calendarWatchChannel.findFirst).not.toHaveBeenCalled();
  });

  it("returns existing channel without calling Google if active", async () => {
    const calListRow = { ...CHANNEL_ROW, kind: "calendarList", calendarId: null };
    mocks.prisma.calendarWatchChannel.findFirst.mockResolvedValue(calListRow);
    expect(await registerCalendarListWatch("user-1")).toBe(calListRow);
    expect(mocks.googleClient.calendarList.watch).not.toHaveBeenCalled();
  });
});

describe("stopWatchChannel", () => {
  it("marks channel inactive and calls channels.stop", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(CHANNEL_ROW);
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.googleClient.channels.stop.mockResolvedValue({});

    await stopWatchChannel("ch-abc");

    expect(mocks.prisma.calendarWatchChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
    expect(mocks.googleClient.channels.stop).toHaveBeenCalled();
  });

  it("marks channel inactive even if channels.stop throws", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(CHANNEL_ROW);
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.googleClient.channels.stop.mockRejectedValue(new Error("network err"));

    await expect(stopWatchChannel("ch-abc")).resolves.not.toThrow();
    expect(mocks.prisma.calendarWatchChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
  });
});

describe("stopAllWatchesForUser", () => {
  it("stops all active channels, continues past individual failures", async () => {
    const channels = [
      { ...CHANNEL_ROW, channelId: "ch-1" },
      { ...CHANNEL_ROW, channelId: "ch-2" },
      { ...CHANNEL_ROW, channelId: "ch-3" },
    ];
    mocks.prisma.calendarWatchChannel.findMany.mockResolvedValue(channels);
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.googleClient.channels.stop
      .mockRejectedValueOnce(new Error("dead token"))
      .mockResolvedValue({});

    await stopAllWatchesForUser("user-1");

    expect(mocks.prisma.calendarWatchChannel.update).toHaveBeenCalledTimes(3);
    expect(mocks.googleClient.channels.stop).toHaveBeenCalledTimes(3);
  });
});

describe("reconcileEventsWatches", () => {
  it("no-ops when GOOGLE_WATCH_DISABLED=1", async () => {
    process.env.GOOGLE_WATCH_DISABLED = "1";
    await reconcileEventsWatches("user-1", ["cal-a"]);
    expect(mocks.prisma.calendarWatchChannel.findMany).not.toHaveBeenCalled();
  });

  it("registers missing calendars and stops removed ones", async () => {
    mocks.prisma.calendarWatchChannel.findMany.mockResolvedValue([
      { channelId: "ch-a", calendarId: "cal-a" },
      { channelId: "ch-b", calendarId: "cal-b" },
    ]);
    // reconcileEventsWatches skips cal-a (already in existingIds) and tries
    // to register cal-c only — so findFirst is called exactly once (for cal-c)
    mocks.prisma.calendarWatchChannel.findFirst.mockResolvedValue(null); // cal-c: not found
    mocks.googleClient.events.watch.mockResolvedValue({
      data: { id: "ch-new", resourceId: "res-new", expiration: "9999999999000" },
    });
    mocks.prisma.calendarWatchChannel.create.mockResolvedValue({});
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue({ ...CHANNEL_ROW, channelId: "ch-b" });
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.googleClient.channels.stop.mockResolvedValue({});

    await reconcileEventsWatches("user-1", ["cal-a", "cal-c"]);

    // cal-c registered
    expect(mocks.googleClient.events.watch).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: "cal-c" }),
    );
    // ch-b stopped (cal-b no longer in target)
    expect(mocks.prisma.calendarWatchChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channelId: "ch-b" }, data: { active: false } }),
    );
  });
});

describe("listExpiringChannels", () => {
  it("queries with correct cutoff and kind filter", async () => {
    mocks.prisma.calendarWatchChannel.findMany.mockResolvedValue([CHANNEL_ROW]);
    const result = await listExpiringChannels(48 * 60 * 60 * 1000, "events");
    expect(mocks.prisma.calendarWatchChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          kind: "events",
          expiration: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    );
    expect(result).toHaveLength(1);
  });
});

describe("renewWatchChannel", () => {
  it("no-ops when GOOGLE_WATCH_DISABLED=1", async () => {
    process.env.GOOGLE_WATCH_DISABLED = "1";
    await renewWatchChannel("ch-abc");
    expect(mocks.prisma.calendarWatchChannel.findUnique).not.toHaveBeenCalled();
  });

  it("marks old channel inactive and registers a new one", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(CHANNEL_ROW);
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.googleClient.channels.stop.mockResolvedValue({});
    mocks.prisma.calendarWatchChannel.findFirst.mockResolvedValue(null); // no existing after mark-inactive
    mocks.googleClient.events.watch.mockResolvedValue({
      data: { id: "ch-new", resourceId: "res-new", expiration: "9999999999000" },
    });
    mocks.prisma.calendarWatchChannel.create.mockResolvedValue({ ...CHANNEL_ROW, channelId: "ch-new" });

    await renewWatchChannel("ch-abc");

    expect(mocks.prisma.calendarWatchChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
    expect(mocks.googleClient.events.watch).toHaveBeenCalled();
  });
});
