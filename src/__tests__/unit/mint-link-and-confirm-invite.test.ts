/**
 * Unit tests for `mintLinkAndConfirmInvite` — the shared helper extracted in
 * Path B commit 1 (bookings → event_action fold pre-refactor).
 *
 * Both the deprecated `bookTimeWithCommit` tool and the forthcoming
 * `create_link({commitMode: "invite"})` action shape will call this helper.
 * These tests pin the contract so the second caller can land safely.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks must be hoisted before importing the SUT ───────────────────────────
vi.mock("@/lib/prisma", () => ({
  prisma: {
    negotiationSession: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/confirm-pipeline", () => ({
  confirmBooking: vi.fn(),
}));

vi.mock("@/agent/actions", () => ({
  handleCreateLink: vi.fn(),
}));

import { mintLinkAndConfirmInvite } from "@/agent/modules/_shared/mint-link-and-confirm-invite";
import { prisma } from "@/lib/prisma";
import { confirmBooking } from "@/lib/confirm-pipeline";
import { handleCreateLink } from "@/agent/actions";

const handleCreateLinkMock = handleCreateLink as unknown as ReturnType<typeof vi.fn>;
const confirmBookingMock = confirmBooking as unknown as ReturnType<typeof vi.fn>;
const findUniqueMock = prisma.negotiationSession.findUnique as unknown as ReturnType<typeof vi.fn>;

const BASE_INPUT = {
  invitee: { email: "guest@example.com", name: "Guest Person" },
  slot: { start: "2026-05-12T17:00:00.000Z", end: "2026-05-12T17:30:00.000Z" },
  intent: { activity: "coffee", durationMinutes: 30, format: "video" as const },
  callerUserId: "host-1",
};

describe("mintLinkAndConfirmInvite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXTAUTH_URL = "https://test.agentenvoy.ai";
  });

  it("happy path: mint → confirm → return meetingUrl from persisted link", async () => {
    handleCreateLinkMock.mockResolvedValue({
      success: true,
      data: { sessionId: "sess-123" },
    });
    confirmBookingMock.mockResolvedValue({
      ok: true,
      outcome: "success",
      status: "confirmed",
      dateTime: BASE_INPUT.slot.start,
      duration: 30,
      format: "video",
      location: null,
      emailSent: true,
      attempt: { outcome: "success", error: null, sessionId: "sess-123", slotStart: null, slotEnd: null },
    });
    findUniqueMock.mockResolvedValue({ link: { slug: "abcd", code: "x9y2" } });

    const result = await mintLinkAndConfirmInvite(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe("sess-123");
    expect(result.meetingUrl).toBe("https://test.agentenvoy.ai/meet/abcd/x9y2");
    expect(result.status).toBe("confirmed");
  });

  it("forwards activity / format / hostNote / location into handleCreateLink params", async () => {
    handleCreateLinkMock.mockResolvedValue({ success: true, data: { sessionId: "sess-1" } });
    confirmBookingMock.mockResolvedValue({
      ok: true,
      outcome: "success",
      status: "confirmed",
      dateTime: BASE_INPUT.slot.start,
      duration: 30,
      format: "in-person",
      location: "Joe's Cafe",
      emailSent: true,
      attempt: { outcome: "success", error: null, sessionId: "sess-1", slotStart: null, slotEnd: null },
    });
    findUniqueMock.mockResolvedValue({ link: { slug: "s", code: "c" } });

    await mintLinkAndConfirmInvite({
      ...BASE_INPUT,
      intent: {
        activity: "lunch",
        durationMinutes: 60,
        format: "in-person",
        topic: "Q3 review",
        hostNote: "ping me if you're running late",
        location: "Joe's Cafe",
      },
    });

    const params = handleCreateLinkMock.mock.calls[0][0] as Record<string, unknown>;
    expect(params.inviteeNames).toEqual(["Guest Person"]);
    expect(params.inviteeEmail).toBe("guest@example.com");
    expect(params.activity).toBe("lunch");
    expect(params.duration).toBe(60);
    expect(params.format).toBe("in-person");
    expect(params.note).toBe("Q3 review");
    expect(params.hostNote).toBe("ping me if you're running late");
    expect(params.location).toBe("Joe's Cafe");
  });

  it("returns validation_failed when handleCreateLink fails", async () => {
    handleCreateLinkMock.mockResolvedValue({ success: false, message: "calendar not connected" });

    const result = await mintLinkAndConfirmInvite(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("validation_failed");
    expect(result.message).toBe("calendar not connected");
    expect(confirmBookingMock).not.toHaveBeenCalled();
  });

  it("returns validation_failed when handleCreateLink succeeds but no sessionId", async () => {
    handleCreateLinkMock.mockResolvedValue({ success: true, data: {} });

    const result = await mintLinkAndConfirmInvite(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("validation_failed");
    expect(confirmBookingMock).not.toHaveBeenCalled();
  });

  it("propagates confirmBooking failure (e.g. slot_mismatch)", async () => {
    handleCreateLinkMock.mockResolvedValue({ success: true, data: { sessionId: "sess-1" } });
    confirmBookingMock.mockResolvedValue({
      ok: false,
      reason: "slot_mismatch",
      message: "Slot no longer offered",
      attempt: { outcome: "slot_mismatch", error: null, sessionId: "sess-1", slotStart: null, slotEnd: null },
    });

    const result = await mintLinkAndConfirmInvite(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("slot_mismatch");
  });

  it("falls back to /meet/unknown when persisted link is missing slug or code", async () => {
    handleCreateLinkMock.mockResolvedValue({ success: true, data: { sessionId: "sess-1" } });
    confirmBookingMock.mockResolvedValue({
      ok: true,
      outcome: "success",
      status: "confirmed",
      dateTime: BASE_INPUT.slot.start,
      duration: 30,
      format: "video",
      location: null,
      emailSent: true,
      attempt: { outcome: "success", error: null, sessionId: "sess-1", slotStart: null, slotEnd: null },
    });
    findUniqueMock.mockResolvedValue({ link: null });

    const result = await mintLinkAndConfirmInvite(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meetingUrl).toBe("https://test.agentenvoy.ai/meet/unknown");
  });

  it("derives duration from slot when intent.durationMinutes is omitted", async () => {
    handleCreateLinkMock.mockResolvedValue({ success: true, data: { sessionId: "sess-1" } });
    confirmBookingMock.mockResolvedValue({
      ok: true,
      outcome: "success",
      status: "confirmed",
      dateTime: BASE_INPUT.slot.start,
      duration: 45,
      format: "video",
      location: null,
      emailSent: true,
      attempt: { outcome: "success", error: null, sessionId: "sess-1", slotStart: null, slotEnd: null },
    });
    findUniqueMock.mockResolvedValue({ link: { slug: "s", code: "c" } });

    const result = await mintLinkAndConfirmInvite({
      ...BASE_INPUT,
      slot: { start: "2026-05-12T17:00:00.000Z", end: "2026-05-12T17:45:00.000Z" },
      intent: { format: "video" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // confirmBooking returned duration=45; helper passes that through.
    expect(result.duration).toBe(45);
    // handleCreateLink should have been called WITHOUT duration param (not in input).
    const params = handleCreateLinkMock.mock.calls[0][0] as Record<string, unknown>;
    expect(params.duration).toBeUndefined();
  });
});
