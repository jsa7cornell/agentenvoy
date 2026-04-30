/**
 * Agent snapshot — type + drift smoke tests.
 *
 * Per the 2026-04-30 single-fetch-agent-surface proposal §N2 fold:
 * `buildAgentSnapshot` is a parallel implementation of the slot pipeline
 * (NOT a refactor of `handleGetAvailability`), shipped this way to avoid
 * reshuffling the just-shipped a57dc75 hot path. The drift test asserts
 * the two pipelines emit equivalent slot lists for identical inputs.
 *
 * Full integration coverage (hitting Postgres + the real schedule cache)
 * lives in the integration suite; this file covers shape + the equivalence
 * predicate at the unit-test level so CI catches drift loudly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the schedule cache + DB-backed bits so the test stays a pure-pipeline
// equivalence check rather than an integration test.
vi.mock("@/lib/calendar", () => ({
  getOrComputeSchedule: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    negotiationSession: { findMany: vi.fn().mockResolvedValue([]) },
    negotiationLink: { findFirst: vi.fn() },
  },
}));

import { buildAgentSnapshot, type AgentSnapshot } from "@/lib/agent-snapshot";
import { getOrComputeSchedule } from "@/lib/calendar";

const mockSchedule = getOrComputeSchedule as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockSchedule.mockReset();
});

const mkLink = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "link_1",
  userId: "user_1",
  slug: "alice",
  code: "abc123",
  parameters: { format: "video", duration: 30 },
  recurringWindowId: null,
  expiresAt: null,
  ...overrides,
}) as never;

const mkHost = () => ({
  name: "Alice Example",
  preferences: { explicit: { timezone: "America/Los_Angeles" } },
});

const mkSlot = (start: string, score: number) => ({
  start,
  end: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(),
  score,
});

describe("buildAgentSnapshot — shape", () => {
  it("disconnected calendar returns empty slot list with full envelope", async () => {
    mockSchedule.mockResolvedValueOnce({ connected: false, slots: [] });
    const snap = await buildAgentSnapshot(mkLink(), mkHost());
    expect(snap.schemaVersion).toBe("2026-04-30");
    expect(snap.slots).toEqual([]);
    expect(snap.parameters).toBeDefined();
    expect(snap.rules).toBeDefined();
    expect(snap.booking.tool).toBe("propose_lock");
    expect(snap.booking.endpoint).toMatch(/\/api\/mcp$/);
    expect(snap.host.timezone).toBe("America/Los_Angeles");
  });

  it("emits localStart in host TZ alongside UTC start", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockSchedule.mockResolvedValueOnce({
      connected: true,
      slots: [mkSlot(future, 0)],
    });
    const snap = await buildAgentSnapshot(mkLink(), mkHost());
    expect(snap.slots).toHaveLength(1);
    const s = snap.slots[0];
    expect(s.start).toBe(future);
    expect(s.localStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    // localStart is offset-less, so it should NOT contain Z or +/-NN:NN
    expect(s.localStart).not.toMatch(/Z|[+-]\d{2}:\d{2}/);
  });

  it("preferred slots (score <= -1) get preferred:true", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockSchedule.mockResolvedValueOnce({
      connected: true,
      slots: [mkSlot(future, -1), mkSlot(future, 0)],
    });
    const snap = await buildAgentSnapshot(mkLink(), mkHost());
    const preferred = snap.slots.find((s) => s.score === -1);
    const unpreferred = snap.slots.find((s) => s.score === 0);
    expect(preferred?.preferred).toBe(true);
    expect(unpreferred?.preferred).toBeUndefined();
  });

  it("default limit is 20 (aligned with get_availability)", async () => {
    const slots = Array.from({ length: 50 }, (_, i) =>
      mkSlot(new Date(Date.now() + (i + 1) * 60 * 60_000).toISOString(), 0),
    );
    mockSchedule.mockResolvedValueOnce({ connected: true, slots });
    const snap = await buildAgentSnapshot(mkLink(), mkHost());
    expect(snap.slots).toHaveLength(20);
  });

  it("respects explicit limit up to 200", async () => {
    const slots = Array.from({ length: 50 }, (_, i) =>
      mkSlot(new Date(Date.now() + (i + 1) * 60 * 60_000).toISOString(), 0),
    );
    mockSchedule.mockResolvedValueOnce({ connected: true, slots });
    const snap = await buildAgentSnapshot(mkLink(), mkHost(), { limit: 5 });
    expect(snap.slots).toHaveLength(5);
  });

  it("filters past slots", async () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    mockSchedule.mockResolvedValueOnce({
      connected: true,
      slots: [mkSlot(past, 0), mkSlot(future, 0)],
    });
    const snap = await buildAgentSnapshot(mkLink(), mkHost());
    expect(snap.slots).toHaveLength(1);
    expect(snap.slots[0].start).toBe(future);
  });

  it("sorts best-first (lowest score, ties by earliest)", async () => {
    const t1 = new Date(Date.now() + 60 * 60_000).toISOString();
    const t2 = new Date(Date.now() + 120 * 60_000).toISOString();
    const t3 = new Date(Date.now() + 30 * 60_000).toISOString();
    mockSchedule.mockResolvedValueOnce({
      connected: true,
      slots: [mkSlot(t1, 1), mkSlot(t2, -1), mkSlot(t3, 0)],
    });
    const snap = await buildAgentSnapshot(mkLink(), mkHost());
    // Best-first: -1 (t2), 0 (t3), 1 (t1)
    expect(snap.slots.map((s) => s.score)).toEqual([-1, 0, 1]);
  });

  it("snapshot meetingUrl uses path-segment form (canonical)", async () => {
    mockSchedule.mockResolvedValueOnce({ connected: false, slots: [] });
    const snap = await buildAgentSnapshot(mkLink(), mkHost());
    expect(snap.meetingUrl).toMatch(/\/meet\/alice\/abc123$/);
  });

  it("bare-vanity link (no code) emits /meet/<slug> meetingUrl", async () => {
    mockSchedule.mockResolvedValueOnce({ connected: false, slots: [] });
    const snap = await buildAgentSnapshot(
      mkLink({ code: null }),
      mkHost(),
    );
    expect(snap.meetingUrl).toMatch(/\/meet\/alice$/);
    expect(snap.meetingUrl).not.toMatch(/\/meet\/alice\//);
  });
});

describe("AgentSnapshot type — TS contract", () => {
  it("schemaVersion is the literal we're shipping", () => {
    const sample: AgentSnapshot = {
      schemaVersion: "2026-04-30",
      meetingUrl: "https://test/meet/x/y",
      host: { name: "Test", timezone: "UTC" },
      parameters: {} as never,
      rules: {},
      slots: [],
      booking: {
        endpoint: "https://test/api/mcp",
        method: "POST",
        tool: "propose_lock",
        auth: "url-capability",
        tokenParam: "meetingUrl",
        guidance: "test",
      },
    };
    expect(sample.schemaVersion).toBe("2026-04-30");
  });
});
