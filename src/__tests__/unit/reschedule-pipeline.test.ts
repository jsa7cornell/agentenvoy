/**
 * reschedule-pipeline unit tests.
 *
 * Mirrors confirm-pipeline.test.ts shape — DB and GCal calls mocked at
 * module boundary. Asserts the cascade order, the GCal-failure-aborts
 * asymmetry vs cancel-pipeline (proposal §B1), and idempotent replay
 * via RescheduleAttempt (proposal §B5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    negotiationSession: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    rescheduleAttempt: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    },
    hold: { updateMany: vi.fn().mockResolvedValue({}) },
    message: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/calendar", () => ({
  assertAgentEnvoyOwnedEvent: vi.fn().mockResolvedValue(undefined),
  updateCalendarEvent: vi.fn(),
  invalidateSchedule: vi.fn().mockResolvedValue(undefined),
  GcalOwnershipError: class GcalOwnershipError extends Error {},
}));

import { prisma } from "@/lib/prisma";
import { updateCalendarEvent } from "@/lib/calendar";
import { rescheduleSession } from "@/lib/reschedule-pipeline";

const mockSessionFind = prisma.negotiationSession.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockSessionUpdate = prisma.negotiationSession.update as unknown as ReturnType<typeof vi.fn>;
const mockAttemptFind = prisma.rescheduleAttempt.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockAttemptCreate = prisma.rescheduleAttempt.create as unknown as ReturnType<typeof vi.fn>;
const mockMessageCreate = prisma.message.create as unknown as ReturnType<typeof vi.fn>;
const mockUpdateEvent = updateCalendarEvent as unknown as ReturnType<typeof vi.fn>;

const baseSession = {
  id: "sess_1",
  hostId: "host_1",
  status: "agreed" as const,
  agreedTime: new Date("2026-05-05T16:00:00Z"),
  agreedFormat: "video",
  duration: 30,
  calendarEventId: "gcal_event_1",
  rescheduleHistory: null,
  link: { inviteeName: "Sarah" },
  holds: [],
  location: null,
};

beforeEach(() => {
  mockSessionFind.mockReset();
  mockSessionUpdate.mockReset().mockResolvedValue({});
  mockAttemptFind.mockReset();
  mockAttemptCreate.mockReset().mockResolvedValue({});
  mockMessageCreate.mockReset().mockResolvedValue({});
  mockUpdateEvent.mockReset();
});

describe("rescheduleSession", () => {
  it("happy path: patches GCal, updates DB, posts message, records attempt", async () => {
    mockSessionFind.mockResolvedValueOnce(baseSession);
    mockUpdateEvent.mockResolvedValueOnce({ eventId: "gcal_event_1", htmlLink: "..." });

    const result = await rescheduleSession({
      sessionId: "sess_1",
      hostId: "host_1",
      newSlot: { start: new Date("2026-05-06T16:00:00Z") },
      initiator: "agent",
      initiatorName: "Test Agent",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("success");
    expect(result.changed).toBe(true);
    expect(result.fromStart).toBe("2026-05-05T16:00:00.000Z");
    expect(result.toStart).toBe("2026-05-06T16:00:00.000Z");

    // GCal patch was called with new times
    expect(mockUpdateEvent).toHaveBeenCalledTimes(1);
    expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockAttemptCreate).toHaveBeenCalledTimes(1);
    expect(mockAttemptCreate.mock.calls[0][0].data.outcome).toBe("success");
  });

  it("GCal patch failure ABORTS — no DB update (asymmetry vs. cancel)", async () => {
    mockSessionFind.mockResolvedValueOnce(baseSession);
    mockUpdateEvent.mockRejectedValueOnce(new Error("gcal 503"));

    const result = await rescheduleSession({
      sessionId: "sess_1",
      hostId: "host_1",
      newSlot: { start: new Date("2026-05-06T16:00:00Z") },
      initiator: "agent",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("gcal_patch_failed");

    // CRITICAL: DB was NOT updated. This is the asymmetry vs cancel-pipeline.
    expect(mockSessionUpdate).not.toHaveBeenCalled();
    expect(mockMessageCreate).not.toHaveBeenCalled();
    // But the failed attempt IS recorded for audit / observability.
    expect(mockAttemptCreate).toHaveBeenCalledTimes(1);
    expect(mockAttemptCreate.mock.calls[0][0].data.outcome).toBe("gcal_patch_failed");
  });

  it("idempotent replay: same idempotencyKey returns prior responseBody, no re-execute", async () => {
    mockAttemptFind.mockResolvedValueOnce({
      responseBody: {
        ok: true,
        fromStart: "2026-05-05T16:00:00.000Z",
        toStart: "2026-05-06T16:00:00.000Z",
        initiator: "agent",
      },
      fromStart: new Date("2026-05-05T16:00:00Z"),
      toStart: new Date("2026-05-06T16:00:00Z"),
    });

    const result = await rescheduleSession({
      sessionId: "sess_1",
      hostId: "host_1",
      newSlot: { start: new Date("2026-05-06T16:00:00Z") },
      initiator: "agent",
      idempotencyKey: "key-123",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.replayedFrom).toBe("RescheduleAttempt");
    expect(result.fromStart).toBe("2026-05-05T16:00:00.000Z");
    expect(result.toStart).toBe("2026-05-06T16:00:00.000Z");

    // No re-execution — neither GCal nor DB touched.
    expect(mockSessionFind).not.toHaveBeenCalled();
    expect(mockUpdateEvent).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("session not found → session_not_found", async () => {
    mockSessionFind.mockResolvedValueOnce(null);
    const result = await rescheduleSession({
      sessionId: "sess_1",
      hostId: "host_1",
      newSlot: { start: new Date("2026-05-06T16:00:00Z") },
      initiator: "agent",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("session_not_found");
  });

  it("non-agreed session → session_not_agreed (state guard)", async () => {
    mockSessionFind.mockResolvedValueOnce({ ...baseSession, status: "active" });
    const result = await rescheduleSession({
      sessionId: "sess_1",
      hostId: "host_1",
      newSlot: { start: new Date("2026-05-06T16:00:00Z") },
      initiator: "agent",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("session_not_agreed");
  });

  it("idempotent at target: same slot, no overrides → already_at_target", async () => {
    mockSessionFind.mockResolvedValueOnce(baseSession);
    const result = await rescheduleSession({
      sessionId: "sess_1",
      hostId: "host_1",
      newSlot: { start: new Date("2026-05-05T16:00:00Z") }, // same as current
      initiator: "agent",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("already_at_target");
    expect(result.changed).toBe(false);
    // No GCal patch, no DB update.
    expect(mockUpdateEvent).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it("appends to rescheduleHistory + sets lastRescheduledAt + clears finalizesAt", async () => {
    mockSessionFind.mockResolvedValueOnce({
      ...baseSession,
      rescheduleHistory: [
        { from: "old1", to: "old2", at: "earlier", by: "host" },
      ],
    });
    mockUpdateEvent.mockResolvedValueOnce({ eventId: "gcal_event_1", htmlLink: "..." });

    await rescheduleSession({
      sessionId: "sess_1",
      hostId: "host_1",
      newSlot: { start: new Date("2026-05-06T16:00:00Z") },
      initiator: "agent",
      initiatorName: "Test",
      reason: "moved up",
    });

    expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockSessionUpdate.mock.calls[0][0];
    const history = updateCall.data.rescheduleHistory as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[1].by).toBe("agent");
    expect(history[1].byName).toBe("Test");
    expect(history[1].reason).toBe("moved up");
    expect(updateCall.data.lastRescheduledAt).toBeInstanceOf(Date);
    expect(updateCall.data.finalizesAt).toBeNull();
  });
});
