/**
 * WISHLIST §1o PR-α — diagnostic + 3-state response shape.
 *
 * Asserts the wire contract for `GET /api/negotiate/slots`:
 *
 *   1. Compute pipeline throws → `{ slotsByDay: null, error: "compute_failed" }`
 *      (was: silent `{ slotsByDay: {} }` on 200, indistinguishable from a
 *      clean run with zero slots).
 *   2. `schedule.connected === false` → `{ slotsByDay: {}, status:
 *      "calendar_disconnected" }`.
 *   3. Clean run with zero offerable slots after filters → `{ slotsByDay:
 *      {}, status: "no_slots" }`.
 *
 * The full compute pipeline is mocked at the test boundary so each variant
 * exercises one branch end-to-end. No DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared module mocks — declared before the route import so vi.mock() hoisting
// resolves them when the route's top-level imports execute.

const mockGetOrComputeSchedule = vi.fn();
vi.mock("@/lib/calendar", () => ({
  getOrComputeSchedule: (...args: unknown[]) => mockGetOrComputeSchedule(...args),
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    negotiationSession: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    message: {
      findFirst: vi.fn(),
    },
    sessionInvitee: {
      findMany: vi.fn(),
    },
    inviteeSlotRsvp: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/timezone", () => ({
  getUserTimezone: () => "America/New_York",
}));

vi.mock("@/lib/scoring", () => ({
  applyEventOverrides: (slots: unknown[]) => slots,
  filterByDuration: (slots: unknown[]) => slots,
}));

vi.mock("@/lib/availability-rules", () => ({
  getActiveLocationRule: () => null,
  compileBookableLinks: () => [],
}));

vi.mock("@/lib/availability-density", () => ({
  computeDensityHorizon: () => 14,
}));

vi.mock("@/lib/scheduling-mode", () => ({
  getSchedulingMode: () => "time" as const,
}));

vi.mock("@/lib/bookable-links", () => ({
  applyBookableWindow: (args: { slots: unknown[] }) => args.slots,
}));

vi.mock("@/lib/bilateral-availability", () => ({
  computeBilateralAvailability: () => [],
}));

import { GET } from "@/app/api/negotiate/slots/route";
import { prisma } from "@/lib/prisma";

const SESSION_ID = "sess_alpha";
const HOST_ID = "user_host";

function makeReq(sessionId: string | null): Parameters<typeof GET>[0] {
  const url = sessionId
    ? `http://localhost:3000/api/negotiate/slots?sessionId=${sessionId}`
    : `http://localhost:3000/api/negotiate/slots`;
  // Minimal NextRequest stub — the route only reads `nextUrl.searchParams.get`.
  const u = new URL(url);
  return {
    nextUrl: u,
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default session lookup: a sessionId-bearing request resolves a host with
  // no special prefs/link rules. Individual tests override as needed.
  (prisma.negotiationSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    hostId: HOST_ID,
    guestId: null,
    host: { preferences: {} },
    link: { rules: {}, recurringWindowId: null },
  });
});

describe("GET /api/negotiate/slots — WISHLIST §1o PR-α response shape", () => {
  it("compute pipeline throws → { slotsByDay: null, error: 'compute_failed' }", async () => {
    // Silence the structured console.error the route now emits — the catch
    // is the path under test, not the log shape (covered separately below).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetOrComputeSchedule.mockRejectedValueOnce(new Error("downstream blew up"));

    const res = await GET(makeReq(SESSION_ID));
    const body = (await (res as unknown as Response).json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.slotsByDay).toBeNull();
    expect(body.error).toBe("compute_failed");
    expect(body).not.toHaveProperty("status");
    // Sanity: the structured log fired and carried sessionId/hostId/error
    // metadata so the future PR-β stack trace lands in Vercel runtime logs.
    expect(errSpy).toHaveBeenCalledWith(
      "[slots] compute pipeline failed",
      expect.objectContaining({
        sessionId: SESSION_ID,
        hostId: HOST_ID,
        errMessage: "downstream blew up",
      }),
    );
    errSpy.mockRestore();
  });

  it("schedule.connected === false → { slotsByDay: {}, status: 'calendar_disconnected' }", async () => {
    mockGetOrComputeSchedule.mockResolvedValueOnce({
      connected: false,
      slots: [],
      hostLocation: null,
    });

    const res = await GET(makeReq(SESSION_ID));
    const body = (await (res as unknown as Response).json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.slotsByDay).toEqual({});
    expect(body.status).toBe("calendar_disconnected");
    expect(body).not.toHaveProperty("error");
  });

  it("clean run, zero offerable slots → { slotsByDay: {}, status: 'no_slots' }", async () => {
    // Connected calendar, returns slots that are all in the past → score
    // filter and `now` filter both wipe them out, pipeline finishes cleanly
    // with an empty `slotsByDay`.
    mockGetOrComputeSchedule.mockResolvedValueOnce({
      connected: true,
      slots: [
        {
          start: "2020-01-01T15:00:00.000Z",
          end: "2020-01-01T15:30:00.000Z",
          score: 0,
        },
      ],
      hostLocation: null,
    });

    const res = await GET(makeReq(SESSION_ID));
    const body = (await (res as unknown as Response).json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.slotsByDay).toEqual({});
    expect(body.status).toBe("no_slots");
    expect(body).not.toHaveProperty("error");
  });
});
