/**
 * CalendarListCache unit tests.
 * Proposal: 2026-05-02_picker-load-perf §3b + §3g
 *
 * Tests the TTL caching behaviour of getCachedCalendarList (via syncCalendar's
 * observable side-effect: how many times client.calendarList.list() is called)
 * and the invalidateCalendarListCache export.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── googleapis mock ──────────────────────────────────────────────────────────
//
// We mock the entire googleapis module so getGoogleCalendarClient never makes
// real network calls. The mock calendar client's calendarList.list and
// events.list are controlled per-test.
//
// vi.hoisted ensures the mock functions are available to the vi.mock factory
// even though vi.mock calls are hoisted to the top of the file.

const { mockCalendarListList, mockEventsList } = vi.hoisted(() => ({
  mockCalendarListList: vi.fn(),
  mockEventsList: vi.fn(),
}));

vi.mock("googleapis", () => {
  // OAuth2 must be a regular function (not an arrow) to allow `new OAuth2(...)`.
  function MockOAuth2(this: {
    setCredentials: () => void;
    refreshAccessToken: () => Promise<{ credentials: object }>;
  }) {
    this.setCredentials = vi.fn();
    this.refreshAccessToken = vi.fn().mockResolvedValue({ credentials: {} });
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: vi.fn(() => ({
        calendarList: { list: mockCalendarListList },
        events: { list: mockEventsList },
      })),
    },
  };
});

// ─── Prisma mock ──────────────────────────────────────────────────────────────

// In-memory store for CalendarListCache rows so we can test TTL expiry.
const calendarListCacheStore: Record<
  string,
  { calendars: unknown; fetchedAt: Date }
> = {};

// Shared fake account — getGoogleCalendarClient reads this.
const fakeAccount = {
  id: "acct-1",
  refresh_token: "rt",
  access_token: "at",
  expires_at: Math.floor(Date.now() / 1000) + 3600, // fresh, no refresh needed
};

const mockPrisma = {
  account: {
    findFirst: vi.fn(async () => fakeAccount),
    update: vi.fn(async () => ({})),
  },
  calendarListCache: {
    findUnique: vi.fn(
      async ({ where }: { where: { userId: string } }) =>
        calendarListCacheStore[where.userId]
          ? { userId: where.userId, ...calendarListCacheStore[where.userId] }
          : null,
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: { userId: string };
        create: { calendars: unknown; fetchedAt: Date };
      }) => {
        calendarListCacheStore[where.userId] = {
          calendars: create.calendars,
          fetchedAt: create.fetchedAt,
        };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
      delete calendarListCacheStore[where.userId];
    }),
  },
  calendarCache: {
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    upsert: vi.fn(async () => ({})),
  },
  user: {
    findUnique: vi.fn(async () => ({
      email: "host@example.com",
      preferences: null,
    })),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stubCalendarList(items: { id: string; summary: string }[]) {
  mockCalendarListList.mockResolvedValueOnce({ data: { items } });
}

function stubNoEvents() {
  mockEventsList.mockResolvedValue({
    data: { items: [], nextSyncToken: "tok" },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CalendarListCache — getCachedCalendarList (via syncCalendar)", () => {
  beforeEach(() => {
    // Reset in-memory store + call counts between tests.
    for (const key of Object.keys(calendarListCacheStore)) {
      delete calendarListCacheStore[key];
    }
    vi.clearAllMocks();
    // Re-stub shared mocks cleared by clearAllMocks.
    mockPrisma.account.findFirst.mockResolvedValue(fakeAccount);
    mockPrisma.calendarListCache.findUnique.mockImplementation(
      async ({ where }: { where: { userId: string } }) =>
        calendarListCacheStore[where.userId]
          ? { userId: where.userId, ...calendarListCacheStore[where.userId] }
          : null,
    );
    mockPrisma.calendarListCache.upsert.mockImplementation(
      async ({
        where,
        create,
      }: {
        where: { userId: string };
        create: { calendars: unknown; fetchedAt: Date };
      }) => {
        calendarListCacheStore[where.userId] = {
          calendars: create.calendars,
          fetchedAt: create.fetchedAt,
        };
      },
    );
    mockPrisma.calendarListCache.deleteMany.mockImplementation(
      async ({ where }: { where: { userId: string } }) => {
        delete calendarListCacheStore[where.userId];
      },
    );
    mockPrisma.calendarCache.findUnique.mockResolvedValue(null);
    mockPrisma.calendarCache.findMany.mockResolvedValue([]);
    mockPrisma.user.findUnique.mockResolvedValue({
      email: "host@example.com",
      preferences: null,
    });
    stubNoEvents();
  });

  it("cache miss → fetches from Google and writes to DB", async () => {
    stubCalendarList([{ id: "cal@example.com", summary: "My Cal" }]);
    const { syncCalendar } = await import("@/lib/calendar");
    await syncCalendar("user-1", ["cal@example.com"]);

    expect(mockCalendarListList).toHaveBeenCalledTimes(1);
    expect(mockPrisma.calendarListCache.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = mockPrisma.calendarListCache.upsert.mock.calls[0][0] as {
      create: { calendars: unknown };
    };
    expect(upsertArg.create.calendars).toEqual([
      { id: "cal@example.com", name: "My Cal" },
    ]);
  });

  it("cache hit within TTL → returns cached, does NOT call Google", async () => {
    // Pre-seed a fresh cache row.
    calendarListCacheStore["user-2"] = {
      calendars: [{ id: "cached@example.com", name: "Cached Cal" }],
      fetchedAt: new Date(), // fresh — within 30-min TTL
    };

    const { syncCalendar } = await import("@/lib/calendar");
    await syncCalendar("user-2", ["cached@example.com"]);

    expect(mockCalendarListList).not.toHaveBeenCalled();
  });

  it("cache hit past TTL → re-fetches from Google", async () => {
    // Seed a stale cache row (31 min old — past the 30-min TTL).
    calendarListCacheStore["user-3"] = {
      calendars: [{ id: "old@example.com", name: "Old Cal" }],
      fetchedAt: new Date(Date.now() - 31 * 60 * 1000),
    };
    stubCalendarList([{ id: "fresh@example.com", summary: "Fresh Cal" }]);

    const { syncCalendar } = await import("@/lib/calendar");
    await syncCalendar("user-3", ["fresh@example.com"]);

    expect(mockCalendarListList).toHaveBeenCalledTimes(1);
    const upsertArg = mockPrisma.calendarListCache.upsert.mock.calls[0][0] as {
      create: { calendars: unknown };
    };
    expect(upsertArg.create.calendars).toEqual([
      { id: "fresh@example.com", name: "Fresh Cal" },
    ]);
  });
});

describe("invalidateCalendarListCache", () => {
  beforeEach(() => {
    for (const key of Object.keys(calendarListCacheStore)) {
      delete calendarListCacheStore[key];
    }
    vi.clearAllMocks();
    mockPrisma.calendarListCache.deleteMany.mockImplementation(
      async ({ where }: { where: { userId: string } }) => {
        delete calendarListCacheStore[where.userId];
      },
    );
  });

  it("removes the cache row so the next syncCalendar re-fetches", async () => {
    calendarListCacheStore["user-4"] = {
      calendars: [{ id: "cal@example.com", name: "My Cal" }],
      fetchedAt: new Date(),
    };

    const { invalidateCalendarListCache } = await import("@/lib/calendar");
    await invalidateCalendarListCache("user-4");

    expect(mockPrisma.calendarListCache.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-4" },
    });
    expect(calendarListCacheStore["user-4"]).toBeUndefined();
  });
});
