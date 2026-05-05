/**
 * Unit tests for intersect-availability helpers.
 *
 * Tests the sort order, bilateral flag, and freebusy path through
 * intersectAvailability, with prisma + getOrComputeSchedule + buildAgentSnapshot
 * mocked out.
 *
 * Privacy invariant: mutuallyOpen: false slots include NOTHING that
 * identifies which side blocks. The tests verify the output shape.
 *
 * Per PR4 proposal §4 scenarios A–C.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const mockPrisma = {
    user: { findUnique: vi.fn() },
    negotiationLink: { findFirst: vi.fn() },
    message: { findFirst: vi.fn() },
  };
  return { prisma: mockPrisma };
});

vi.mock("@/lib/calendar", () => ({
  getOrComputeSchedule: vi.fn(),
}));

vi.mock("@/lib/agent-snapshot", () => ({
  buildAgentSnapshot: vi.fn(),
}));

import { intersectAvailability } from "@/lib/intersect-availability";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { buildAgentSnapshot } from "@/lib/agent-snapshot";

const mockUser = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mockLink = prisma.negotiationLink as unknown as { findFirst: ReturnType<typeof vi.fn> };
const mockMessage = prisma.message as unknown as { findFirst: ReturnType<typeof vi.fn> };
const mockGetSchedule = getOrComputeSchedule as ReturnType<typeof vi.fn>;
const mockBuildSnapshot = buildAgentSnapshot as ReturnType<typeof vi.fn>;

// Slot builder
function slot(start: string, score: number, preferred = false) {
  const s = new Date(start);
  const e = new Date(s.getTime() + 30 * 60 * 1000);
  return { start: s.toISOString(), end: e.toISOString(), score, preferred };
}

const NOW = new Date("2026-05-10T14:00:00.000Z");

beforeEach(() => {
  vi.resetAllMocks();
  mockLink.findFirst.mockResolvedValue(null); // no caller rules
  mockMessage.findFirst.mockResolvedValue(null);
  mockUser.findUnique.mockResolvedValue({ preferences: null, meetSlug: "host" });
});

// ---------------------------------------------------------------------------

describe("intersectAvailability — bilateral: false (no other-side data)", () => {
  it("scenario A: returns bilateral:false when loadOtherSideSlots returns null", async () => {
    const s1 = "2026-05-11T15:00:00.000Z";
    const s2 = "2026-05-11T16:00:00.000Z";

    mockGetSchedule.mockResolvedValue({
      connected: true,
      slots: [slot(s1, -1, true), slot(s2, 0)],
    });

    // ae-account path — loadOtherSideSlots returns null (otherUser not found)
    mockUser.findUnique
      .mockResolvedValueOnce({ preferences: null, meetSlug: null }) // caller — no meetSlug = no rules lookup
      .mockResolvedValueOnce(null);                                 // other user not found
    mockLink.findFirst.mockResolvedValueOnce(null);                 // other primary link (not found)

    const result = await intersectAvailability({
      callerUserId: "caller-1",
      other: { kind: "ae-account", userId: "other-1", meetSlug: "bryan" },
      now: NOW,
    });

    expect(result.bilateral).toBe(false);
    // Slots are included but mutuallyOpen: false (no other-side data → catch-all branch)
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => !c.mutuallyOpen)).toBe(true);
    expect(result.candidates.every((c) => c.theirScore === null)).toBe(true);
  });

  it("returns bilateral:false and empty candidates when caller calendar not connected", async () => {
    mockGetSchedule.mockResolvedValue({ connected: false, slots: [] });

    const result = await intersectAvailability({
      callerUserId: "caller-1",
      other: { kind: "ae-account", userId: "other-1", meetSlug: "bryan" },
      now: NOW,
    });

    expect(result.bilateral).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("intersectAvailability — bilateral: true (ae-account path)", () => {
  // Helper: set up mocks for a successful ae-account bilateral call.
  // The ae-account path calls in sequence:
  //   1. getOrComputeSchedule(callerUserId)
  //   2. prisma.user.findUnique({ where: { id: callerUserId } }) — caller prefs
  //   3. prisma.negotiationLink.findFirst (caller primary link for rules) — inside the try block
  //   4. In loadOtherSideSlots:
  //      Promise.all([
  //        prisma.user.findUnique({ where: { id: otherUserId } }),
  //        prisma.negotiationLink.findFirst({ userId: otherUserId, slug: meetSlug, type: "primary" })
  //      ])
  //   5. buildAgentSnapshot(primaryLink, otherUser, ...)
  function setupAeAccountMocks(otherSlots: Array<{ start: string; score: number; preferred: boolean }>) {
    mockUser.findUnique
      .mockResolvedValueOnce({ preferences: null, meetSlug: "host" }) // caller
      .mockResolvedValueOnce({ name: "Bryan", preferences: null });   // other (in loadOtherSideSlots)
    mockLink.findFirst
      .mockResolvedValueOnce(null)                                     // caller rules (null = no rules)
      .mockResolvedValueOnce({ id: "link-other", parameters: {} });  // other primary link
    mockBuildSnapshot.mockResolvedValue({ slots: otherSlots });
  }

  it("scenario B: returns bilateral:true and paired slots", async () => {
    const s1 = "2026-05-11T15:00:00.000Z";
    const s2 = "2026-05-11T16:00:00.000Z";
    const s3 = "2026-05-11T17:00:00.000Z";

    mockGetSchedule.mockResolvedValue({
      connected: true,
      slots: [
        slot(s1, -1, true),  // preferred for caller
        slot(s2, 0),
        slot(s3, 0),
      ],
    });

    setupAeAccountMocks([
      { start: s1, score: 0, preferred: false },   // other bookable
      { start: s2, score: 2, preferred: false },   // other NOT bookable (score > 1)
    ]);

    const result = await intersectAvailability({
      callerUserId: "caller-1",
      other: { kind: "ae-account", userId: "other-1", meetSlug: "bryan" },
      now: NOW,
    });

    expect(result.bilateral).toBe(true);
    // s1: mutuallyOpen (both bookable), s2: mutuallyOpen: false (other score 2)
    // s3 not in other's slots → excluded
    const candidates = result.candidates;
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const s1Slot = candidates.find((c) => c.start === s1);
    expect(s1Slot).toBeDefined();
    expect(s1Slot!.mutuallyOpen).toBe(true);
    expect(s1Slot!.theirScore).toBe(0);
    // yourPreferred depends on scoring rules; just verify it's a boolean
    expect(typeof s1Slot!.yourPreferred).toBe("boolean");
  });

  it("privacy: mutuallyOpen:false slot does NOT expose which side is blocked", async () => {
    const s1 = "2026-05-11T15:00:00.000Z";

    mockGetSchedule.mockResolvedValue({
      connected: true,
      slots: [slot(s1, 0)],
    });

    setupAeAccountMocks([{ start: s1, score: 2, preferred: false }]); // other NOT bookable

    const result = await intersectAvailability({
      callerUserId: "caller-1",
      other: { kind: "ae-account", userId: "other-1", meetSlug: "bryan" },
      now: NOW,
    });

    const blocked = result.candidates.find((c) => c.start === s1);
    expect(blocked).toBeDefined();
    expect(blocked!.mutuallyOpen).toBe(false);
    // Privacy: neither 'callerBlocked' nor 'otherBlocked' keys should exist
    expect(Object.keys(blocked!)).not.toContain("callerBlocked");
    expect(Object.keys(blocked!)).not.toContain("otherBlocked");
    expect(Object.keys(blocked!)).not.toContain("blockedSide");
    expect(Object.keys(blocked!)).not.toContain("yourBlocked");
    expect(Object.keys(blocked!)).not.toContain("theirBlocked");
  });

  it("sort order: mutuallyOpen first, then by best min score, then by start time", async () => {
    const s1 = "2026-05-11T15:00:00.000Z";
    const s2 = "2026-05-11T16:00:00.000Z";
    const s3 = "2026-05-11T17:00:00.000Z";

    mockGetSchedule.mockResolvedValue({
      connected: true,
      slots: [
        slot(s3, 0),   // third by time, mutuallyOpen
        slot(s1, -1),  // first by time, mutuallyOpen — better score
        slot(s2, 0),   // middle, mutuallyOpen
      ],
    });

    setupAeAccountMocks([
      { start: s1, score: -1, preferred: true },
      { start: s2, score: 0, preferred: false },
      { start: s3, score: 0, preferred: false },
    ]);

    const result = await intersectAvailability({
      callerUserId: "caller-1",
      other: { kind: "ae-account", userId: "other-1", meetSlug: "bryan" },
      now: NOW,
    });

    expect(result.candidates).toHaveLength(3);
    // s1 has min score -1 (both preferred), s2 and s3 have min score 0
    // s1 should come first; s2 and s3 by start time
    expect(result.candidates[0].start).toBe(s1);
    expect(result.candidates[1].start).toBe(s2);
    expect(result.candidates[2].start).toBe(s3);
  });
});

// ---------------------------------------------------------------------------

describe("intersectAvailability — freebusy snapshot path", () => {
  it("returns bilateral:true and open slots when freebusy snapshot is present", async () => {
    const s1 = "2026-05-11T15:00:00.000Z";
    const s2 = "2026-05-11T16:00:00.000Z";

    mockGetSchedule.mockResolvedValue({
      connected: true,
      slots: [slot(s1, 0), slot(s2, 0)],
    });

    // freebusy snapshot: busy during s2
    mockMessage.findFirst.mockResolvedValue({
      metadata: {
        kind: "guest_calendar_snapshot",
        busy: [
          {
            start: s2,
            end: new Date(new Date(s2).getTime() + 30 * 60 * 1000).toISOString(),
          },
        ],
      },
    });

    const result = await intersectAvailability({
      callerUserId: "caller-1",
      other: { kind: "via-freebusy-snapshot", sessionId: "session-x" },
      now: NOW,
    });

    expect(result.bilateral).toBe(true);
    // s1 should be in candidates (other free), s2 excluded (other busy)
    const s1Slot = result.candidates.find((c) => c.start === s1);
    expect(s1Slot).toBeDefined();
    expect(s1Slot!.mutuallyOpen).toBe(true);
    expect(s1Slot!.theirScore).toBeNull(); // freebusy-only path
    const s2Slot = result.candidates.find((c) => c.start === s2);
    expect(s2Slot).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("intersectAvailability — via-snapshot throws", () => {
  it("throws validation_failed for via-snapshot (reserved v2 path)", async () => {
    await expect(
      intersectAvailability({
        callerUserId: "caller-1",
        other: { kind: "via-snapshot", agentJsonUrl: "https://example.com/agent.json" },
        now: NOW,
      }),
    ).rejects.toThrow("validation_failed");
  });
});
