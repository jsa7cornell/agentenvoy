import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScoredSlot } from "@/lib/scoring";
import type { GuestSnapshotEvent, GuestSnapshotBusy } from "@/lib/guest-snapshot";

// ─── Prisma mock ─────────────────────────────────────────────────────────────
//
// `computeBilateralForSession` reads two things from the DB: the session
// (with host) and the most recent `guest_calendar_snapshot` system message.
// Tests configure each via `setSession` / `setSnapshot`. Mocking at module
// scope keeps the test surface focused on the compute logic, not the DB
// shape.

const mockSession = vi.fn();
const mockMessage = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    negotiationSession: { findUnique: (...args: unknown[]) => mockSession(...args) },
    message: { findFirst: (...args: unknown[]) => mockMessage(...args) },
  },
}));

const mockGetOrComputeSchedule = vi.fn();
vi.mock("@/lib/calendar", () => ({
  getOrComputeSchedule: (...args: unknown[]) => mockGetOrComputeSchedule(...args),
}));

// `getUserTimezone` used to resolve host tz from preferences.
vi.mock("@/lib/timezone", () => ({
  getUserTimezone: (prefs: Record<string, unknown> | null) => {
    if (!prefs) return "America/Los_Angeles";
    const explicit = (prefs.explicit as Record<string, unknown> | undefined) || {};
    return (explicit.timezone as string) || "America/Los_Angeles";
  },
}));

// Lazy-imported via dynamic import — top-level await disallowed under
// the project's TS module target.
let computeBilateralForSession: typeof import("@/lib/bilateral-availability").computeBilateralForSession;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function hostSlot(startIso: string, score: number): ScoredSlot {
  const end = new Date(new Date(startIso).getTime() + 30 * 60 * 1000).toISOString();
  return { start: startIso, end, score, kind: "open" } as ScoredSlot;
}

function setSession(opts: {
  hostName?: string | null;
  guestTimezone?: string | null;
  hostTimezone?: string;
}) {
  // Use `in` check so explicit `null` is preserved (vs. unset → default).
  const hostName = "hostName" in opts ? opts.hostName : "John Anderson";
  mockSession.mockResolvedValueOnce({
    hostId: "host-1",
    guestTimezone: opts.guestTimezone ?? null,
    host: {
      name: hostName,
      preferences: opts.hostTimezone
        ? { explicit: { timezone: opts.hostTimezone } }
        : null,
    },
  });
}

function setSnapshot(
  shape:
    | null
    | {
        busy?: GuestSnapshotBusy[];
        events?: GuestSnapshotEvent[];
        scoredSlots?: ScoredSlot[];
      },
) {
  if (shape === null) {
    mockMessage.mockResolvedValueOnce(null);
    return;
  }
  mockMessage.mockResolvedValueOnce({
    metadata: { kind: "guest_calendar_snapshot", ...shape },
  });
}

function setHostSchedule(slots: ScoredSlot[]) {
  mockGetOrComputeSchedule.mockResolvedValueOnce({ connected: true, slots });
}

beforeEach(async () => {
  mockSession.mockReset();
  mockMessage.mockReset();
  mockGetOrComputeSchedule.mockReset();
  ({ computeBilateralForSession } = await import("@/lib/bilateral-availability"));
  // `Date.now` reference: Tue Apr 28 2026 17:00 UTC (= 10am PT). All
  // fixture slots in tests are after this so they pass the "skip past"
  // filter in computeBilateralAvailability.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-28T17:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("computeBilateralForSession — guards", () => {
  it("returns { available: false } when session is missing", async () => {
    mockSession.mockResolvedValueOnce(null);
    const out = await computeBilateralForSession("nonexistent");
    expect(out.available).toBe(false);
    expect(out.byDay).toEqual([]);
    expect(out.hostFirstName).toBe("Host");
  });

  it("returns { available: false } when session has no snapshot", async () => {
    setSession({});
    setSnapshot(null);
    const out = await computeBilateralForSession("session-1");
    expect(out.available).toBe(false);
    expect(out.hostFirstName).toBe("John");
    expect(out.byDay).toEqual([]);
  });
});

describe("computeBilateralForSession — payload shape", () => {
  it("emits matched + looseMutual + hasHostHours per day", async () => {
    setSession({});
    setSnapshot({
      busy: [
        // Wed 10am PT busy (= 17:00 UTC).
        { start: "2026-04-29T17:00:00.000Z", end: "2026-04-29T17:30:00.000Z" },
      ],
    });
    setHostSchedule([
      hostSlot("2026-04-29T16:00:00.000Z", 1), // Wed 9am PT — host bookable, guest free → matched
      hostSlot("2026-04-29T17:00:00.000Z", 1), // Wed 10am PT — host bookable, guest busy → omitted
      hostSlot("2026-04-29T18:00:00.000Z", 2), // Wed 11am PT — host protected, guest free → not in matched
      hostSlot("2026-04-29T19:00:00.000Z", 1), // Wed 12pm PT — host bookable, guest free → matched
    ]);
    const out = await computeBilateralForSession("session-1");
    expect(out.available).toBe(true);
    expect(out.byDay).toHaveLength(1);
    expect(out.byDay[0].matched).toHaveLength(2);
    expect(out.byDay[0].hasHostHours).toBe(true);
  });

  it("emits hasHostHours: true even on days with no matched slots, when host has any bookable slot", async () => {
    setSession({});
    setSnapshot({
      // Every host slot collides with a guest busy — zero matched, but host
      // has hours that day so hasHostHours stays true.
      busy: [
        { start: "2026-04-29T16:00:00.000Z", end: "2026-04-29T20:00:00.000Z" },
      ],
    });
    setHostSchedule([
      hostSlot("2026-04-29T16:00:00.000Z", 1),
      hostSlot("2026-04-29T17:00:00.000Z", 1),
    ]);
    const out = await computeBilateralForSession("session-1");
    expect(out.byDay[0].matched).toHaveLength(0);
    expect(out.byDay[0].looseMutual).toHaveLength(0);
    expect(out.byDay[0].hasHostHours).toBe(true);
  });
});

describe("computeBilateralForSession — Cut 2 conflict gating", () => {
  it("omits conflicts entirely when includeConflicts is false (default — Sonnet tool path)", async () => {
    setSession({});
    setSnapshot({
      busy: [
        { start: "2026-04-29T17:00:00.000Z", end: "2026-04-29T17:30:00.000Z" },
      ],
      events: [
        { start: "2026-04-29T17:00:00.000Z", end: "2026-04-29T17:30:00.000Z", title: "Standup" },
      ],
    });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    const out = await computeBilateralForSession("session-1", { includeConflicts: false });
    // Conflicts MUST be empty — the deal-room thread is host-visible and Cut 2
    // says titles never enter chat. This is the load-bearing privacy invariant.
    for (const day of out.byDay) {
      expect(day.conflicts).toEqual([]);
    }
  });

  it("populates conflicts when includeConflicts is true (picker render path)", async () => {
    setSession({});
    setSnapshot({
      busy: [
        { start: "2026-04-29T17:00:00.000Z", end: "2026-04-29T17:30:00.000Z" },
      ],
      events: [
        { start: "2026-04-29T17:00:00.000Z", end: "2026-04-29T17:30:00.000Z", title: "Standup" },
      ],
    });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    const out = await computeBilateralForSession("session-1", { includeConflicts: true });
    const dayWithConflict = out.byDay.find((d) => d.conflicts.length > 0);
    expect(dayWithConflict).toBeDefined();
    expect(dayWithConflict?.conflicts[0].title).toBe("Standup");
  });

  it("emits no conflicts when snapshot has events but includeConflicts is omitted (defaults to false)", async () => {
    setSession({});
    setSnapshot({
      busy: [{ start: "2026-04-29T17:00:00.000Z", end: "2026-04-29T17:30:00.000Z" }],
      events: [
        { start: "2026-04-29T17:00:00.000Z", end: "2026-04-29T17:30:00.000Z", title: "Standup" },
      ],
    });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    // No options arg at all — defaults must lock to includeConflicts=false.
    const out = await computeBilateralForSession("session-1");
    for (const day of out.byDay) {
      expect(day.conflicts).toEqual([]);
    }
  });
});

describe("computeBilateralForSession — dual-tz rendering", () => {
  it("emits hostLabel only when host and viewer share a timezone", async () => {
    setSession({ hostTimezone: "America/Los_Angeles", guestTimezone: "America/Los_Angeles" });
    setSnapshot({ busy: [] });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    const out = await computeBilateralForSession("session-1");
    const time = out.byDay[0].matched[0];
    expect(time.hostLabel).toBeTruthy();
    expect(time.viewerLabel).toBeUndefined();
  });

  it("emits both hostLabel and viewerLabel when host and viewer differ", async () => {
    setSession({ hostTimezone: "America/Los_Angeles", guestTimezone: "America/New_York" });
    setSnapshot({ busy: [] });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    const out = await computeBilateralForSession("session-1");
    const time = out.byDay[0].matched[0];
    expect(time.hostLabel).toBeTruthy();
    expect(time.viewerLabel).toBeTruthy();
    expect(time.hostLabel).not.toBe(time.viewerLabel);
  });
});

describe("computeBilateralForSession — legacy snapshot fallback", () => {
  it("derives guest slots from legacy scoredSlots when busy/events are absent", async () => {
    setSession({});
    setSnapshot({
      // Old shape — pre-PR-A1 snapshot still in DB for in-flight sessions.
      // No `busy` or `events`, only `scoredSlots`.
      scoredSlots: [
        hostSlot("2026-04-29T16:00:00.000Z", 1),
      ],
    });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    const out = await computeBilateralForSession("session-1");
    // Compute still produces matched output — backward-compat preserved.
    expect(out.available).toBe(true);
    expect(out.byDay[0].matched).toHaveLength(1);
  });
});

describe("computeBilateralForSession — host first name resolution", () => {
  it("uses canonical hostFirstName util output", async () => {
    setSession({ hostName: "Mary Jane Watson" });
    setSnapshot({ busy: [] });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    const out = await computeBilateralForSession("session-1");
    expect(out.hostFirstName).toBe("Mary");
  });

  it("falls back to 'Host' when host has no name", async () => {
    setSession({ hostName: null });
    setSnapshot({ busy: [] });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    const out = await computeBilateralForSession("session-1");
    expect(out.hostFirstName).toBe("Host");
  });
});

// ─── hostStableSlots (Wedge B — proposal 2026-05-02_picker-load-perf) ────────

describe("computeBilateralForSession — hostStableSlots", () => {
  it("uses pre-loaded hostStableSlots and does NOT call getOrComputeSchedule", async () => {
    setSession({});
    setSnapshot({ busy: [] });
    // Provide pre-loaded slots — mock should NOT be called.
    const preloaded: ScoredSlot[] = [hostSlot("2026-04-29T16:00:00.000Z", 1)];
    const out = await computeBilateralForSession("session-1", {
      hostStableSlots: preloaded,
    });
    expect(mockGetOrComputeSchedule).not.toHaveBeenCalled();
    expect(out.available).toBe(true);
    expect(out.byDay[0].matched).toHaveLength(1);
  });

  it("produces the same output whether slots come from hostStableSlots or internal load", async () => {
    const slots: ScoredSlot[] = [
      hostSlot("2026-04-29T16:00:00.000Z", 1), // matched
      hostSlot("2026-04-29T17:00:00.000Z", 1), // guest busy → omitted from matched
    ];
    const busy = [{ start: "2026-04-29T17:00:00.000Z", end: "2026-04-29T17:30:00.000Z" }];

    // Run via internal load path.
    setSession({});
    setSnapshot({ busy });
    setHostSchedule(slots);
    const internal = await computeBilateralForSession("session-1");

    // Run via hostStableSlots path.
    setSession({});
    setSnapshot({ busy });
    const preloaded = await computeBilateralForSession("session-2", {
      hostStableSlots: slots,
    });

    expect(preloaded.byDay).toEqual(internal.byDay);
    // The pre-loaded path must not trigger the mock.
    expect(mockGetOrComputeSchedule).toHaveBeenCalledTimes(1); // only the internal call
  });

  it("falls back to internal load when hostStableSlots is omitted", async () => {
    setSession({});
    setSnapshot({ busy: [] });
    setHostSchedule([hostSlot("2026-04-29T16:00:00.000Z", 1)]);
    await computeBilateralForSession("session-1");
    expect(mockGetOrComputeSchedule).toHaveBeenCalledTimes(1);
  });
});
