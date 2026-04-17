import { beforeEach, describe, expect, it, vi } from "vitest";

// Prisma mocks must be hoisted above the import under test.
const userCountMock = vi.fn();
const sessionCountMock = vi.fn();
const sessionGroupByMock = vi.fn();
const sideEffectGroupByMock = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { count: (...args: unknown[]) => userCountMock(...args) },
    negotiationSession: {
      count: (...args: unknown[]) => sessionCountMock(...args),
      groupBy: (...args: unknown[]) => sessionGroupByMock(...args),
    },
    sideEffectLog: {
      groupBy: (...args: unknown[]) => sideEffectGroupByMock(...args),
    },
  },
}));

import { buildDevStatsEmail, type DevStatsParams } from "@/lib/emails/dev-stats";
import { gatherDevStats } from "@/lib/emails/dev-stats-gather";

function baseParams(overrides: Partial<DevStatsParams> = {}): DevStatsParams {
  const windowEnd = new Date("2026-04-17T16:00:00Z");
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  return {
    windowStart,
    windowEnd,
    newUsers: 0,
    sessionsCreated: 0,
    sessionsConfirmed: 0,
    sessionsCancelled: 0,
    sessionsExpired: 0,
    sessionsEscalated: 0,
    formatBreakdown: [],
    failures: [],
    totalFailures: 0,
    ...overrides,
  };
}

describe("buildDevStatsEmail", () => {
  it("renders a subject containing the day label", () => {
    const { subject } = buildDevStatsEmail(baseParams());
    expect(subject).toContain("AgentEnvoy daily");
    expect(subject).toMatch(/[A-Z][a-z]{2},? [A-Z][a-z]{2} \d+/);
  });

  it("renders without errors when everything is zero", () => {
    const { html } = buildDevStatsEmail(baseParams());
    expect(html).toContain("New users");
    expect(html).toContain("Sessions created");
    expect(html).toContain("No failed side effects");
  });

  it("prints all six activity rows with their numeric values", () => {
    const { html } = buildDevStatsEmail(
      baseParams({
        newUsers: 3,
        sessionsCreated: 12,
        sessionsConfirmed: 5,
        sessionsCancelled: 1,
        sessionsExpired: 2,
        sessionsEscalated: 0,
      }),
    );
    expect(html).toMatch(/New users<[\s\S]*?>3</);
    expect(html).toMatch(/Sessions created<[\s\S]*?>12</);
    expect(html).toMatch(/Sessions confirmed<[\s\S]*?>5</);
    expect(html).toMatch(/Sessions cancelled<[\s\S]*?>1</);
    expect(html).toMatch(/Sessions expired<[\s\S]*?>2</);
    expect(html).toMatch(/Sessions escalated<[\s\S]*?>0</);
  });

  it("renders the format breakdown rows sorted by caller", () => {
    const { html } = buildDevStatsEmail(
      baseParams({
        sessionsConfirmed: 7,
        formatBreakdown: [
          { format: "video", count: 5 },
          { format: "phone", count: 2 },
        ],
      }),
    );
    expect(html).toContain("video");
    expect(html).toContain("phone");
    expect(html.indexOf("video")).toBeLessThan(html.indexOf("phone"));
  });

  it("renders '(none)' when the format breakdown is empty", () => {
    const { html } = buildDevStatsEmail(baseParams());
    expect(html).toContain("(none)");
  });

  it("shows per-kind failure rows with a warning banner when failures exist", () => {
    const { html } = buildDevStatsEmail(
      baseParams({
        failures: [
          { kind: "email.send", count: 2 },
          { kind: "calendar.create_event", count: 1 },
        ],
        totalFailures: 3,
      }),
    );
    expect(html).toContain("3 failed side effect");
    expect(html).toContain("email.send");
    expect(html).toContain("calendar.create_event");
    expect(html).not.toContain("No failed side effects");
  });

  it("pluralizes the failure banner correctly for a single failure", () => {
    const { html } = buildDevStatsEmail(
      baseParams({
        failures: [{ kind: "email.send", count: 1 }],
        totalFailures: 1,
      }),
    );
    expect(html).toContain("1 failed side effect");
    expect(html).not.toContain("1 failed side effects");
  });

  it("renders the window range in the body", () => {
    const { html } = buildDevStatsEmail(baseParams());
    expect(html).toContain("PT");
    expect(html).toContain("→");
  });
});

describe("gatherDevStats", () => {
  beforeEach(() => {
    userCountMock.mockReset();
    sessionCountMock.mockReset();
    sessionGroupByMock.mockReset();
    sideEffectGroupByMock.mockReset();
  });

  it("returns a fully-populated DevStatsParams object, sorted and totalled", async () => {
    userCountMock.mockResolvedValueOnce(3);
    // Five session counts in declaration order:
    //   created, confirmed, cancelled, expired, escalated
    sessionCountMock
      .mockResolvedValueOnce(12) // created
      .mockResolvedValueOnce(5) // confirmed
      .mockResolvedValueOnce(1) // cancelled
      .mockResolvedValueOnce(2) // expired
      .mockResolvedValueOnce(0); // escalated
    sessionGroupByMock.mockResolvedValueOnce([
      { agreedFormat: "phone", _count: { _all: 2 } },
      { agreedFormat: "video", _count: { _all: 3 } },
    ]);
    sideEffectGroupByMock.mockResolvedValueOnce([
      { kind: "calendar.create_event", _count: { _all: 1 } },
      { kind: "email.send", _count: { _all: 2 } },
    ]);

    const windowEnd = new Date("2026-04-17T16:00:00Z");
    const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
    const stats = await gatherDevStats(windowStart, windowEnd);

    expect(stats.newUsers).toBe(3);
    expect(stats.sessionsCreated).toBe(12);
    expect(stats.sessionsConfirmed).toBe(5);
    expect(stats.sessionsCancelled).toBe(1);
    expect(stats.sessionsExpired).toBe(2);
    expect(stats.sessionsEscalated).toBe(0);
    expect(stats.formatBreakdown).toEqual([
      { format: "video", count: 3 },
      { format: "phone", count: 2 },
    ]);
    expect(stats.failures).toEqual([
      { kind: "email.send", count: 2 },
      { kind: "calendar.create_event", count: 1 },
    ]);
    expect(stats.totalFailures).toBe(3);
    expect(stats.windowStart).toBe(windowStart);
    expect(stats.windowEnd).toBe(windowEnd);
  });

  it("coerces a null agreedFormat into '(unspecified)'", async () => {
    userCountMock.mockResolvedValueOnce(0);
    sessionCountMock
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    sessionGroupByMock.mockResolvedValueOnce([
      { agreedFormat: null, _count: { _all: 1 } },
    ]);
    sideEffectGroupByMock.mockResolvedValueOnce([]);

    const windowEnd = new Date("2026-04-17T16:00:00Z");
    const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
    const stats = await gatherDevStats(windowStart, windowEnd);

    expect(stats.formatBreakdown).toEqual([{ format: "(unspecified)", count: 1 }]);
  });

  it("returns 0 totalFailures and empty arrays on a quiet day", async () => {
    userCountMock.mockResolvedValueOnce(0);
    sessionCountMock
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    sessionGroupByMock.mockResolvedValueOnce([]);
    sideEffectGroupByMock.mockResolvedValueOnce([]);

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
    const stats = await gatherDevStats(windowStart, windowEnd);

    expect(stats.totalFailures).toBe(0);
    expect(stats.failures).toEqual([]);
    expect(stats.formatBreakdown).toEqual([]);
  });
});
