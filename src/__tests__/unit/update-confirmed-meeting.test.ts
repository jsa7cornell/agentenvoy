/**
 * Tests for src/lib/update-confirmed-meeting.ts.
 *
 * Coverage targets (from the decided proposal §6 / "Tests required in PR-A"):
 *   - Resolution chain for each field (location, format, time, duration).
 *   - Format-only patch leaves location unchanged (partial-state semantics).
 *   - TOCTOU guard: updateMany WHERE status="agreed" rejects mid-call.
 *   - Concurrent-edit regression: disjoint-field patches both succeed.
 *   - GCal failure path: DB is NOT written when events.patch throws.
 *   - Past-start-time refusal: typed RefusalReason.
 *   - Group session refusal.
 *   - Ownership mismatch.
 *   - Empty changes: no-op, returns ok:true with current state, no GCal call.
 *   - Auto-derived system message text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (hoisted per the agent-actions.test.ts pattern) ───────────────────

const mockPrisma = vi.hoisted(() => ({
  negotiationSession: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  negotiationLink: {
    update: vi.fn(),
  },
  message: {
    create: vi.fn(),
  },
}));

const mockCalendar = vi.hoisted(() => ({
  assertAgentEnvoyOwnedEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  GcalOwnershipError: class GcalOwnershipError extends Error {
    constructor(eventId: string) {
      super(`Event ${eventId} is not owned by this AgentEnvoy session`);
      this.name = "GcalOwnershipError";
    }
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/calendar", () => mockCalendar);

// Import AFTER mocks so the helper picks up the mocked modules.
import {
  resolveMeetingState,
  updateConfirmedMeeting,
} from "@/lib/update-confirmed-meeting";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_ID = "sess-1";
const HOST_ID = "host-1";
const EVENT_ID = "gcal-evt-1";

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    hostId: HOST_ID,
    status: "agreed",
    archived: false,
    calendarEventId: EVENT_ID,
    agreedTime: new Date("2026-06-01T17:00:00.000Z"),
    agreedFormat: "video",
    duration: 30,
    link: {
      id: "link-1",
      type: "personalized",
      mode: null,
      parameters: { format: "video", duration: 30, location: "Konditorei" },
    },
    gcalHtmlLink: "https://calendar.google.com/event?eid=abc",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path mock returns.
  mockPrisma.negotiationSession.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.negotiationLink.update.mockResolvedValue({});
  mockPrisma.message.create.mockResolvedValue({});
  mockCalendar.assertAgentEnvoyOwnedEvent.mockResolvedValue(undefined);
  mockCalendar.updateCalendarEvent.mockResolvedValue({
    eventId: EVENT_ID,
    htmlLink: "https://calendar.google.com/event?eid=abc-updated",
  });
});

// ─── resolveMeetingState ─────────────────────────────────────────────────────

describe("resolveMeetingState", () => {
  it("returns current state when changes is empty", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const result = await resolveMeetingState(SESSION_ID, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.format).toBe("video");
      expect(result.resolved.location).toBe("Konditorei");
      expect(result.resolved.duration).toBe(30);
    }
  });

  it("applies supplied location verbatim", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const result = await resolveMeetingState(SESSION_ID, { location: "Blue Bottle" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.location).toBe("Blue Bottle");
  });

  it("null location clears the field", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const result = await resolveMeetingState(SESSION_ID, { location: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.location).toBeNull();
  });

  it("format-only change preserves current location (partial-state)", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const result = await resolveMeetingState(SESSION_ID, { format: "in-person" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.format).toBe("in-person");
      // Location was NOT auto-rederived — keeps current value.
      expect(result.resolved.location).toBe("Konditorei");
    }
  });

  it("derives endTime from startTime + duration when endTime absent", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const start = new Date("2026-06-15T17:00:00.000Z");
    const result = await resolveMeetingState(SESSION_ID, {
      startTime: start,
      duration: 45,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expectedEnd = new Date(start.getTime() + 45 * 60 * 1000);
      expect(result.resolved.endTime.getTime()).toBe(expectedEnd.getTime());
    }
  });
});

// ─── Refusal cases ───────────────────────────────────────────────────────────

describe("updateConfirmedMeeting — refusals", () => {
  it("refuses session_not_found when row is missing", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(null);
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { location: "X" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_not_found");
    expect(mockCalendar.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it("refuses session_not_agreed when status !== 'agreed'", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(
      makeSession({ status: "active" }),
    );
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { location: "X" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_not_agreed");
    expect(mockCalendar.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it("refuses session_archived when archived=true", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(
      makeSession({ archived: true }),
    );
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { format: "phone" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_archived");
  });

  it("refuses no_calendar_event when calendarEventId is null", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(
      makeSession({ calendarEventId: null }),
    );
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { location: "X" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_calendar_event");
  });

  it("refuses group_session_not_supported when link.mode === 'group'", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(
      makeSession({
        link: {
          id: "link-1",
          type: "personalized",
          mode: "group",
          parameters: { format: "video" },
        },
      }),
    );
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { location: "X" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("group_session_not_supported");
  });

  it("refuses past_start_time when supplied startTime is in the past", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { startTime: new Date("2020-01-01T00:00:00.000Z") },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("past_start_time");
    expect(mockCalendar.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it("refuses ownership_mismatch when event isn't AE-tagged", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    mockCalendar.assertAgentEnvoyOwnedEvent.mockRejectedValue(
      new mockCalendar.GcalOwnershipError(EVENT_ID),
    );
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { location: "X" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ownership_mismatch");
    expect(mockCalendar.updateCalendarEvent).not.toHaveBeenCalled();
  });
});

// ─── GCal failure path ──────────────────────────────────────────────────────

describe("updateConfirmedMeeting — GCal failure", () => {
  it("does NOT write DB when events.patch throws", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    mockCalendar.updateCalendarEvent.mockRejectedValue(
      new Error("Google Calendar API: 503 Backend Error"),
    );
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { location: "Blue Bottle" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("gcal_failed");
      expect(result.message).toMatch(/Calendar update failed/);
    }
    // Critical invariant: no DB writes after GCal failure.
    expect(mockPrisma.negotiationSession.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.negotiationLink.update).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });
});

// ─── Happy paths ─────────────────────────────────────────────────────────────

describe("updateConfirmedMeeting — happy paths", () => {
  it("location update writes statusLabel + link.parameters + system message", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { location: "Blue Bottle on Mission" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.location).toBe("Blue Bottle on Mission");
    // GCal patch carried the location.
    expect(mockCalendar.updateCalendarEvent).toHaveBeenCalledWith(
      HOST_ID,
      EVENT_ID,
      SESSION_ID,
      expect.objectContaining({ location: "Blue Bottle on Mission" }),
      expect.objectContaining({ notifyAttendees: false }),
    );
    // DB write — statusLabel + TOCTOU guard.
    expect(mockPrisma.negotiationSession.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, status: "agreed", archived: false },
      data: expect.objectContaining({
        statusLabel: "Location updated to Blue Bottle on Mission",
      }),
    });
    // link.parameters mirrored.
    expect(mockPrisma.negotiationLink.update).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({
        parameters: expect.objectContaining({
          location: "Blue Bottle on Mission",
        }),
      }),
    });
    // System message with actor metadata.
    expect(mockPrisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: SESSION_ID,
        role: "system",
        content: "Location updated to Blue Bottle on Mission",
        metadata: expect.objectContaining({
          kind: "host_update",
          field: "location",
          actor: { invoker: "host" },
        }),
      }),
    });
  });

  it("time update writes agreedTime + confirmedAt + duration", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const newStart = new Date("2026-07-01T18:00:00.000Z");
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { startTime: newStart, duration: 60 },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(true);
    expect(mockPrisma.negotiationSession.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, status: "agreed", archived: false },
      data: expect.objectContaining({
        agreedTime: newStart,
        confirmedAt: newStart,
        duration: 60,
      }),
    });
  });

  it("format update writes both agreedFormat AND session.format", async () => {
    // Inherits the seventh drift bug fix from PR-A. update-gcal (today)
    // accepts format in its body schema but writes neither field; the helper
    // writes both.
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { format: "in-person" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(true);
    expect(mockPrisma.negotiationSession.updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, status: "agreed", archived: false },
      data: expect.objectContaining({
        agreedFormat: "in-person",
        format: "in-person",
      }),
    });
    expect(mockPrisma.negotiationLink.update).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({
        parameters: expect.objectContaining({ format: "in-person" }),
      }),
    });
  });

  it("empty changes is a no-op (returns ok:true, no GCal call, no writes)", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      {},
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(true);
    expect(mockCalendar.updateCalendarEvent).not.toHaveBeenCalled();
    expect(mockPrisma.negotiationSession.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });

  it("does NOT mirror to link.parameters for non-personalized links", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(
      makeSession({
        link: {
          id: "link-1",
          type: "primary",
          mode: null,
          parameters: { format: "video", duration: 30 },
        },
      }),
    );
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { format: "phone" },
      { actor: { invoker: "host" } },
    );
    expect(result.ok).toBe(true);
    expect(mockPrisma.negotiationLink.update).not.toHaveBeenCalled();
  });

  it("propagates notifyAttendees=true to GCal when caller opts in", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    await updateConfirmedMeeting(
      SESSION_ID,
      { startTime: new Date("2026-07-15T17:00:00.000Z"), duration: 45 },
      { actor: { invoker: "host" }, notifyAttendees: true },
    );
    expect(mockCalendar.updateCalendarEvent).toHaveBeenCalledWith(
      HOST_ID,
      EVENT_ID,
      SESSION_ID,
      expect.any(Object),
      { notifyAttendees: true },
    );
  });

  it("respects systemMessageOverride when supplied", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    await updateConfirmedMeeting(
      SESSION_ID,
      { location: "Blue Bottle" },
      {
        actor: { invoker: "agent", triggeringRole: "guest" },
        systemMessageOverride: "Got it — moved to Blue Bottle per Susan's request.",
      },
    );
    expect(mockPrisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: "Got it — moved to Blue Bottle per Susan's request.",
        metadata: expect.objectContaining({
          actor: { invoker: "agent", triggeringRole: "guest" },
        }),
      }),
    });
  });

  it("multi-field change concatenates summary with separators + lists fields[]", async () => {
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    await updateConfirmedMeeting(
      SESSION_ID,
      {
        location: "Konditorei, Portola Valley",
        format: "in-person",
      },
      { actor: { invoker: "host" } },
    );
    expect(mockPrisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: expect.stringMatching(/Location updated.*Format updated/),
        metadata: expect.objectContaining({
          kind: "host_update",
          fields: expect.arrayContaining(["location", "format"]),
        }),
      }),
    });
  });
});

// ─── TOCTOU + concurrent regression ─────────────────────────────────────────

describe("updateConfirmedMeeting — TOCTOU + concurrency", () => {
  it("updateMany WHERE status='agreed' guard is structurally present", async () => {
    // The proposal's invariant: DB writes carry a WHERE-agreed guard so a
    // session cancelled between gate and write doesn't get its agreed* fields
    // resurrected. We assert the WHERE shape is in place — actual count=0 vs
    // count=1 behavior is Prisma's responsibility.
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    mockPrisma.negotiationSession.updateMany.mockResolvedValue({ count: 0 });
    const result = await updateConfirmedMeeting(
      SESSION_ID,
      { location: "Konditorei" },
      { actor: { invoker: "host" } },
    );
    // GCal still got patched (request happens before DB write); helper still
    // reports ok=true since the GCal write succeeded. DB count=0 is silent —
    // poll will reconcile. Documented in proposal §5.5.
    expect(result.ok).toBe(true);
    expect(mockPrisma.negotiationSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SESSION_ID, status: "agreed", archived: false },
      }),
    );
  });

  it("disjoint-field concurrent edits both succeed (proposal §5.5 / reviewer C2)", async () => {
    // Two calls land back-to-back, one changes time, the other changes
    // location. Both should succeed; neither should stomp the other's field.
    mockPrisma.negotiationSession.findUnique.mockResolvedValue(makeSession());
    const newStart = new Date("2026-08-01T17:00:00.000Z");
    const [r1, r2] = await Promise.all([
      updateConfirmedMeeting(
        SESSION_ID,
        { startTime: newStart, duration: 30 },
        { actor: { invoker: "host" } },
      ),
      updateConfirmedMeeting(
        SESSION_ID,
        { location: "Sightglass" },
        { actor: { invoker: "guest" } },
      ),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // GCal called twice — once per patch.
    expect(mockCalendar.updateCalendarEvent).toHaveBeenCalledTimes(2);
    // DB write also twice — one per call. Each call's payload is field-disjoint.
    const calls = mockPrisma.negotiationSession.updateMany.mock.calls;
    expect(calls).toHaveLength(2);
    const dataA = calls[0][0].data;
    const dataB = calls[1][0].data;
    // Neither call wrote BOTH the time-fields and the location-fields together.
    const hasTime = (d: Record<string, unknown>) => "agreedTime" in d;
    const hasLocation = (d: Record<string, unknown>) => "statusLabel" in d;
    expect(hasTime(dataA) || hasTime(dataB)).toBe(true);
    expect(hasLocation(dataA) || hasLocation(dataB)).toBe(true);
    // No single call stomped both — each call wrote only its own fields.
    expect(hasTime(dataA) && hasLocation(dataA)).toBe(false);
    expect(hasTime(dataB) && hasLocation(dataB)).toBe(false);
  });
});
