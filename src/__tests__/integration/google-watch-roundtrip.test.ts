/**
 * Integration tests for the Google Calendar push notification roundtrip.
 * Uses a real test DB; Google API calls are stubbed.
 * Proposal 2026-05-04_google-calendar-push-notifications §6b.
 *
 * Tests:
 *  1. Bootstrap: registerEventsWatch creates DB row matching Google's response
 *  2. Ping flow: POST webhook → CalendarCache updated + lastPingAt/lastSyncDiffAt set
 *  3. Expiration flow: runRenewGoogleWatches renews a near-expired channel
 *  4. Dead-token flow: ping with isDeadGoogleAuthError → channel marked inactive, token cleared
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDb } from "./helpers/db";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock Google API — we never call the real Google in integration tests
// ---------------------------------------------------------------------------

const { mockGoogleEventsWatch, mockGoogleChannelsStop, waitUntilRef } = vi.hoisted(() => ({
  mockGoogleEventsWatch: vi.fn(),
  mockGoogleChannelsStop: vi.fn(),
  waitUntilRef: { current: Promise.resolve() as Promise<unknown> },
}));

vi.mock("@/lib/calendar", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/calendar")>();
  return {
    ...original,
    getGoogleCalendarClient: vi.fn().mockResolvedValue({
      events: { watch: mockGoogleEventsWatch, list: vi.fn().mockResolvedValue({ data: { items: [], nextSyncToken: "new-token" } }) },
      calendarList: { watch: vi.fn().mockResolvedValue({ data: { id: "ch-list", resourceId: "res-list", expiration: "9999999999000" } }) },
      channels: { stop: mockGoogleChannelsStop },
    }),
    // Explicitly mock these so the webhook handler (which imports from @/lib/calendar)
    // gets the mock — the spread original cannot intercept same-file calls to getGoogleCalendarClient.
    incrementalSyncForUser: vi.fn().mockResolvedValue(false),
    isDeadGoogleAuthError: vi.fn().mockReturnValue(false),
    clearGoogleRefreshToken: vi.fn(),
    invalidateSchedule: vi.fn(),
    invalidateCalendarListCache: vi.fn(),
  };
});

vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => { waitUntilRef.current = p; return p; },
}));

vi.mock("@/lib/prisma", async () => {
  const { prisma } = await import("./helpers/db");
  return { prisma };
});

// ---------------------------------------------------------------------------

import { POST } from "@/app/api/webhooks/google-calendar/route";
import { registerEventsWatch, renewWatchChannel } from "@/lib/google-watch";

let testUserId: string;

async function postAndFlush(req: NextRequest) {
  const res = await POST(req);
  await waitUntilRef.current;
  return res;
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  waitUntilRef.current = Promise.resolve();
  delete process.env.GOOGLE_WATCH_DISABLED;
  process.env.PUBLIC_BASE_URL = "https://agentenvoy.ai";

  // Create a minimal test user
  const user = await prisma.user.create({
    data: {
      email: `test-${Date.now()}@example.com`,
      name: "Test User",
    },
  });
  testUserId = user.id;

  // Stub Google account record so getGoogleCalendarClient finds it
  await prisma.account.create({
    data: {
      userId: testUserId,
      type: "oauth",
      provider: "google",
      providerAccountId: "google-123",
      access_token: "acc-tok",
      refresh_token: "ref-tok",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: "openid email profile https://www.googleapis.com/auth/calendar.events",
    },
  });
});

// ---------------------------------------------------------------------------
// 1. Bootstrap
// ---------------------------------------------------------------------------

describe("registerEventsWatch", () => {
  it("creates a DB row with channelId, resourceId, expiration, token matching Google's response", async () => {
    mockGoogleEventsWatch.mockResolvedValue({
      data: { id: "ch-bootstrap", resourceId: "res-bootstrap", expiration: "9999999999000" },
    });

    await registerEventsWatch(testUserId, "primary");

    const row = await prisma.calendarWatchChannel.findUnique({
      where: { channelId: "ch-bootstrap" },
    });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(testUserId);
    expect(row!.calendarId).toBe("primary");
    expect(row!.resourceId).toBe("res-bootstrap");
    expect(row!.expiration).toEqual(new Date(9999999999000));
    expect(row!.active).toBe(true);
    expect(row!.kind).toBe("events");
    expect(row!.token).toHaveLength(64); // 32 bytes hex
  });

  it("idempotent: second call returns existing row without calling Google again", async () => {
    mockGoogleEventsWatch.mockResolvedValue({
      data: { id: "ch-idempotent", resourceId: "res-idempotent", expiration: "9999999999000" },
    });

    await registerEventsWatch(testUserId, "primary");
    await registerEventsWatch(testUserId, "primary");

    expect(mockGoogleEventsWatch).toHaveBeenCalledTimes(1);
    const rows = await prisma.calendarWatchChannel.findMany({
      where: { userId: testUserId, calendarId: "primary", active: true },
    });
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Ping flow
// ---------------------------------------------------------------------------

describe("webhook POST", () => {
  it("updates lastPingAt and lastSyncDiffAt after a successful events sync with changes", async () => {
    // Create a channel row
    const token = "integration-test-token";
    await prisma.calendarWatchChannel.create({
      data: {
        channelId: "ch-ping-test",
        userId: testUserId,
        calendarId: "primary",
        resourceId: "res-1",
        token,
        kind: "events",
        expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        active: true,
      },
    });

    // incrementalSyncForUser reports changes found → handler should set lastSyncDiffAt
    const { incrementalSyncForUser } = await import("@/lib/calendar");
    vi.mocked(incrementalSyncForUser).mockResolvedValueOnce(true);

    const req = new NextRequest("http://localhost/api/webhooks/google-calendar", {
      method: "POST",
      headers: {
        "x-goog-channel-id": "ch-ping-test",
        "x-goog-channel-token": token,
        "x-goog-resource-state": "exists",
      },
    });

    const res = await postAndFlush(req);
    expect(res.status).toBe(200);

    const updated = await prisma.calendarWatchChannel.findUnique({
      where: { channelId: "ch-ping-test" },
    });
    expect(updated!.lastPingAt).not.toBeNull();
    expect(updated!.lastSyncDiffAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Expiration / renewal flow
// ---------------------------------------------------------------------------

describe("renewWatchChannel", () => {
  it("marks old channel inactive and creates a new active row", async () => {
    // Start with a channel nearing expiry
    await prisma.calendarWatchChannel.create({
      data: {
        channelId: "ch-expiring",
        userId: testUserId,
        calendarId: "primary",
        resourceId: "res-old",
        token: "old-token",
        kind: "events",
        expiration: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h — would trigger renewal
        active: true,
      },
    });

    mockGoogleChannelsStop.mockResolvedValue({});
    mockGoogleEventsWatch.mockResolvedValue({
      data: { id: "ch-renewed", resourceId: "res-new", expiration: "9999999999000" },
    });

    await renewWatchChannel("ch-expiring");

    const old = await prisma.calendarWatchChannel.findUnique({
      where: { channelId: "ch-expiring" },
    });
    expect(old!.active).toBe(false);

    const renewed = await prisma.calendarWatchChannel.findUnique({
      where: { channelId: "ch-renewed" },
    });
    expect(renewed).not.toBeNull();
    expect(renewed!.active).toBe(true);
    expect(renewed!.userId).toBe(testUserId);
  });
});

// ---------------------------------------------------------------------------
// 4. Dead-token flow
// ---------------------------------------------------------------------------

describe("dead-token handling in webhook handler", () => {
  it("marks all user channels inactive and clears refresh token on isDeadGoogleAuthError", async () => {
    const { isDeadGoogleAuthError, clearGoogleRefreshToken } = await import("@/lib/calendar");
    vi.mocked(isDeadGoogleAuthError).mockReturnValue(true);

    const token = "dead-token-test";
    await prisma.calendarWatchChannel.create({
      data: {
        channelId: "ch-dead",
        userId: testUserId,
        calendarId: "primary",
        resourceId: "res-dead",
        token,
        kind: "events",
        expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        active: true,
      },
    });

    const { incrementalSyncForUser } = await import("@/lib/calendar");
    vi.mocked(incrementalSyncForUser).mockRejectedValueOnce(new Error("invalid_grant"));
    mockGoogleChannelsStop.mockResolvedValue({});

    const req = new NextRequest("http://localhost/api/webhooks/google-calendar", {
      method: "POST",
      headers: {
        "x-goog-channel-id": "ch-dead",
        "x-goog-channel-token": token,
        "x-goog-resource-state": "exists",
      },
    });

    const res = await postAndFlush(req);
    expect(res.status).toBe(200);

    expect(clearGoogleRefreshToken).toHaveBeenCalledWith(testUserId);

    const channel = await prisma.calendarWatchChannel.findUnique({
      where: { channelId: "ch-dead" },
    });
    expect(channel!.active).toBe(false);
  });
});
