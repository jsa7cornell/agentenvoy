/**
 * Unit tests for /api/webhooks/google-calendar POST handler.
 * Proposal 2026-05-04_google-calendar-push-notifications §6a.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() so factory closures can reference these vars
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Capture the promise passed to waitUntil so tests can await it explicitly.
  // The handler doesn't await waitUntil's return value, so without this the
  // background IIFE runs in later microtask cycles — after test assertions fire.
  const waitUntilRef: { current: Promise<unknown> } = { current: Promise.resolve() };

  return {
    prisma: {
      calendarWatchChannel: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    },
    incrementalSyncForUser: vi.fn(),
    invalidateSchedule: vi.fn(),
    invalidateCalendarListCache: vi.fn(),
    isDeadGoogleAuthError: vi.fn(),
    clearGoogleRefreshToken: vi.fn(),
    stopAllWatchesForUser: vi.fn(),
    waitUntilRef,
    waitUntil: (p: Promise<unknown>) => {
      waitUntilRef.current = p;
      return p;
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

vi.mock("@/lib/calendar", () => ({
  incrementalSyncForUser: mocks.incrementalSyncForUser,
  invalidateSchedule: mocks.invalidateSchedule,
  invalidateCalendarListCache: mocks.invalidateCalendarListCache,
  isDeadGoogleAuthError: mocks.isDeadGoogleAuthError,
  clearGoogleRefreshToken: mocks.clearGoogleRefreshToken,
}));

vi.mock("@/lib/google-watch", () => ({
  stopAllWatchesForUser: mocks.stopAllWatchesForUser,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
}));

// ---------------------------------------------------------------------------

import { POST } from "@/app/api/webhooks/google-calendar/route";

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/google-calendar", {
    method: "POST",
    headers,
  });
}

// Await POST then flush the waitUntil background work
async function postAndFlush(req: NextRequest) {
  const res = await POST(req);
  await mocks.waitUntilRef.current;
  return res;
}

const ACTIVE_CHANNEL = {
  channelId: "ch-123",
  userId: "user-1",
  calendarId: "cal@gmail.com",
  resourceId: "res-1",
  token: "secret-token",
  kind: "events",
  active: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.waitUntilRef.current = Promise.resolve();
  delete process.env.GOOGLE_WATCH_DISABLED;
});

describe("POST /api/webhooks/google-calendar", () => {
  it("returns 200 no-op when GOOGLE_WATCH_DISABLED=1", async () => {
    process.env.GOOGLE_WATCH_DISABLED = "1";
    const res = await POST(makeRequest({ "x-goog-channel-id": "ch-123", "x-goog-channel-token": "tok" }));
    expect(res.status).toBe(200);
    expect(mocks.prisma.calendarWatchChannel.findUnique).not.toHaveBeenCalled();
  });

  it("returns 400 when x-goog-channel-id is missing", async () => {
    const res = await POST(makeRequest({ "x-goog-channel-token": "tok" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when x-goog-channel-token is missing", async () => {
    const res = await POST(makeRequest({ "x-goog-channel-id": "ch-123" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when channelId is unknown", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ "x-goog-channel-id": "unknown", "x-goog-channel-token": "tok" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when channel is inactive", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue({ ...ACTIVE_CHANNEL, active: false });
    const res = await POST(
      makeRequest({ "x-goog-channel-id": "ch-123", "x-goog-channel-token": "secret-token" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when token mismatches (correct channelId, wrong token)", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(ACTIVE_CHANNEL);
    const res = await POST(
      makeRequest({ "x-goog-channel-id": "ch-123", "x-goog-channel-token": "wrong-token" }),
    );
    expect(res.status).toBe(404);
  });

  it("sync state: updates lastPingAt, does NOT call incrementalSync", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(ACTIVE_CHANNEL);
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    const res = await postAndFlush(
      makeRequest({
        "x-goog-channel-id": "ch-123",
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "sync",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.prisma.calendarWatchChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastPingAt: expect.any(Date) }) }),
    );
    expect(mocks.incrementalSyncForUser).not.toHaveBeenCalled();
  });

  it("exists/events: calls incrementalSync + invalidateSchedule, sets lastSyncDiffAt when changes found", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(ACTIVE_CHANNEL);
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.incrementalSyncForUser.mockResolvedValue(true);
    mocks.invalidateSchedule.mockResolvedValue(undefined);

    const res = await postAndFlush(
      makeRequest({
        "x-goog-channel-id": "ch-123",
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.incrementalSyncForUser).toHaveBeenCalledWith("user-1", "cal@gmail.com");
    expect(mocks.invalidateSchedule).toHaveBeenCalledWith("user-1");
    expect(mocks.prisma.calendarWatchChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSyncDiffAt: expect.any(Date) }),
      }),
    );
  });

  it("does NOT set lastSyncDiffAt when incrementalSync returns false (no changes)", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(ACTIVE_CHANNEL);
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.incrementalSyncForUser.mockResolvedValue(false);
    mocks.invalidateSchedule.mockResolvedValue(undefined);

    await postAndFlush(
      makeRequest({
        "x-goog-channel-id": "ch-123",
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
      }),
    );
    const updateCall = mocks.prisma.calendarWatchChannel.update.mock.calls[0]?.[0];
    expect(updateCall).toBeDefined();
    expect(updateCall.data.lastSyncDiffAt).toBeUndefined();
  });

  it("exists/calendarList: calls invalidateCalendarListCache, not incrementalSync", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue({
      ...ACTIVE_CHANNEL,
      kind: "calendarList",
      calendarId: null,
    });
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.invalidateCalendarListCache.mockResolvedValue(undefined);

    const res = await postAndFlush(
      makeRequest({
        "x-goog-channel-id": "ch-123",
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.invalidateCalendarListCache).toHaveBeenCalledWith("user-1");
    expect(mocks.incrementalSyncForUser).not.toHaveBeenCalled();
  });

  it("dead-token: clearGoogleRefreshToken called BEFORE stopAllWatchesForUser, still returns 200", async () => {
    mocks.prisma.calendarWatchChannel.findUnique.mockResolvedValue(ACTIVE_CHANNEL);
    mocks.prisma.calendarWatchChannel.update.mockResolvedValue({});
    mocks.incrementalSyncForUser.mockRejectedValue(new Error("invalid_grant"));
    mocks.isDeadGoogleAuthError.mockReturnValue(true);

    const callOrder: string[] = [];
    mocks.clearGoogleRefreshToken.mockImplementation(async () => { callOrder.push("clear"); });
    mocks.stopAllWatchesForUser.mockImplementation(async () => { callOrder.push("stop"); });

    const res = await postAndFlush(
      makeRequest({
        "x-goog-channel-id": "ch-123",
        "x-goog-channel-token": "secret-token",
        "x-goog-resource-state": "exists",
      }),
    );
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(["clear", "stop"]);
  });
});
