/**
 * `update_link` recurrence-patch path (proposal §3.3, 2026-05-03).
 *
 * Closes the Rule 21(c) drift latent since the parent recurring-meeting
 * proposal's PR-A shipped 2026-04-23: composer playbook tells the LLM that
 * series-level edits go through `update_link` with a `recurrence` param,
 * but the handler silently ignored that emit. This test pins the handler-
 * side fix that finally honors the patch.
 *
 * Cases:
 *   1. Valid recurrence patch → persisted on link.recurrence + tracked as
 *      a material edit.
 *   2. Patch with `recurrence: null` → recurrence cleared (link reverts to
 *      one-off; greeting falls back).
 *   3. Malformed patch → handler returns clean error; existing recurrence
 *      preserved.
 *   4. Pre-anchor → post-anchor recurrence promotion accepted (host editing
 *      a freshly-created series before the guest committed).
 *   5. Identical patch (no actual change) → no spurious "edited" tracking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeActions } from "@/agent/actions";
import type { LinkRecurrence } from "@/lib/recurrence";

const mockPrisma = vi.hoisted(() => ({
  negotiationSession: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  negotiationLink: {
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({ id: "link-1" }),
  },
  message: {
    create: vi.fn(),
    count: vi.fn().mockResolvedValue(1),
  },
  user: {
    findUnique: vi.fn(),
  },
  account: {
    findFirst: vi.fn().mockResolvedValue({ scope: "calendar" }),
  },
  hold: {
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  sessionInvitee: {
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/utils", () => ({ generateCode: () => "test-code-123" }));
vi.mock("@/lib/calendar", () => ({
  createTentativeHoldEvent: vi.fn(async () => ({ eventId: "g", htmlLink: "h" })),
  deleteCalendarEvent: vi.fn(async () => undefined),
  invalidateSchedule: vi.fn(async () => undefined),
}));

const HOST_USER_ID = "host-user-1";
const LINK_CODE = "u36ggs";

// Pre-anchor recurrence (composer's emit shape — guest picks anchor)
const preAnchorRec: LinkRecurrence = {
  v: "1",
  pattern: "weekly",
  timezone: "America/Los_Angeles",
  anchor: { durationMin: 30 },
};

// Post-anchor recurrence (after guest committed)
const committedRec: LinkRecurrence = {
  v: "1",
  pattern: "weekly",
  timezone: "America/Los_Angeles",
  anchor: { firstDateLocal: "2026-05-04", timeLocal: "15:00", durationMin: 30 },
};

function makeRecurringLink(recurrence: unknown) {
  return {
    id: "link-1",
    userId: HOST_USER_ID,
    code: LINK_CODE,
    inviteeName: "Pat",
    topic: "Piano lessons",
    topicSource: "activity",
    parameters: { format: "in-person", duration: 30 },
    recurrence,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.negotiationSession.update.mockResolvedValue({});
  mockPrisma.negotiationSession.findMany.mockResolvedValue([]);
  mockPrisma.account.findFirst.mockResolvedValue({ scope: "calendar" });
  mockPrisma.negotiationLink.update.mockResolvedValue({ id: "link-1" });
});

describe("handleExpandLink — recurrence patch", () => {
  it("persists a valid pre-anchor → biweekly cadence change", async () => {
    mockPrisma.negotiationLink.findFirst.mockResolvedValue(makeRecurringLink(preAnchorRec));
    const newRec: LinkRecurrence = { ...preAnchorRec, pattern: "biweekly" };

    const results = await executeActions(
      [{ action: "update_link", params: { code: LINK_CODE, recurrence: newRec } }],
      HOST_USER_ID,
    );

    expect(results[0].success).toBe(true);
    expect(mockPrisma.negotiationLink.update).toHaveBeenCalled();
    const call = mockPrisma.negotiationLink.update.mock.calls[0][0];
    expect(call.data.recurrence).toMatchObject({
      v: "1",
      pattern: "biweekly",
      timezone: "America/Los_Angeles",
      anchor: { durationMin: 30 },
    });
    // Material-edit tracking should include "recurrence"
    expect(call.data.lastEditedFields).toContain("recurrence");
    expect(call.data.lastMaterialEditAt).toBeInstanceOf(Date);
  });

  it("persists a count bound when host explicitly bounds the series", async () => {
    mockPrisma.negotiationLink.findFirst.mockResolvedValue(makeRecurringLink(preAnchorRec));

    await executeActions(
      [
        {
          action: "update_link",
          params: {
            code: LINK_CODE,
            recurrence: { ...preAnchorRec, endBy: { count: 12 } },
          },
        },
      ],
      HOST_USER_ID,
    );

    const call = mockPrisma.negotiationLink.update.mock.calls[0][0];
    expect(call.data.recurrence.endBy).toEqual({ count: 12 });
  });

  it("clears recurrence when host emits recurrence: null", async () => {
    mockPrisma.negotiationLink.findFirst.mockResolvedValue(makeRecurringLink(committedRec));

    const results = await executeActions(
      [{ action: "update_link", params: { code: LINK_CODE, recurrence: null } }],
      HOST_USER_ID,
    );

    expect(results[0].success).toBe(true);
    const call = mockPrisma.negotiationLink.update.mock.calls[0][0];
    // Prisma.JsonNull is the SQL-NULL sentinel for nullable Json columns.
    // We just need to assert the update sent SOMETHING for `recurrence` and
    // it isn't a real recurrence object.
    expect(call.data.recurrence).toBeDefined();
    expect(call.data.recurrence?.v).toBeUndefined();
    expect(call.data.lastEditedFields).toContain("recurrence");
  });

  it("rejects a malformed recurrence patch with a clean error", async () => {
    mockPrisma.negotiationLink.findFirst.mockResolvedValue(makeRecurringLink(preAnchorRec));

    const results = await executeActions(
      [
        {
          action: "update_link",
          params: {
            code: LINK_CODE,
            recurrence: {
              v: "1",
              pattern: "yearly", // unsupported
              timezone: "America/Los_Angeles",
              anchor: { durationMin: 30 },
            },
          },
        },
      ],
      HOST_USER_ID,
    );

    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/invalid recurrence/i);
    expect(results[0].message).toMatch(/pattern/i);
    // Existing recurrence preserved — handler short-circuits before update.
    expect(mockPrisma.negotiationLink.update).not.toHaveBeenCalled();
  });

  it("accepts a pre-anchor → committed promotion (firstDateLocal + timeLocal added)", async () => {
    mockPrisma.negotiationLink.findFirst.mockResolvedValue(makeRecurringLink(preAnchorRec));

    await executeActions(
      [
        {
          action: "update_link",
          params: { code: LINK_CODE, recurrence: committedRec },
        },
      ],
      HOST_USER_ID,
    );

    const call = mockPrisma.negotiationLink.update.mock.calls[0][0];
    expect(call.data.recurrence.anchor.firstDateLocal).toBe("2026-05-04");
    expect(call.data.recurrence.anchor.timeLocal).toBe("15:00");
  });

  it("identical patch does not trigger material-edit tracking for recurrence", async () => {
    mockPrisma.negotiationLink.findFirst.mockResolvedValue(makeRecurringLink(committedRec));

    await executeActions(
      [
        {
          action: "update_link",
          params: { code: LINK_CODE, recurrence: committedRec, format: "phone" },
        },
      ],
      HOST_USER_ID,
    );

    const call = mockPrisma.negotiationLink.update.mock.calls[0][0];
    // recurrence is still in the write (host re-emitted it; that's fine),
    // but should NOT appear in lastEditedFields since the value didn't change.
    expect(call.data.lastEditedFields).not.toContain("recurrence");
    // format DID change → still tracked.
    expect(call.data.lastEditedFields).toContain("format");
  });

  it("recurrence-only patch (no other fields) is sufficient to pass the gate", async () => {
    mockPrisma.negotiationLink.findFirst.mockResolvedValue(makeRecurringLink(preAnchorRec));
    const newRec: LinkRecurrence = { ...preAnchorRec, pattern: "monthly_nth_weekday" };

    const results = await executeActions(
      [{ action: "update_link", params: { code: LINK_CODE, recurrence: newRec } }],
      HOST_USER_ID,
    );

    // Without §3.3, a bare-recurrence patch would have failed the
    // "needs at least one field to change" gate (recurrence wasn't on the
    // assignable-keys list). With the fix, recurrence is a first-class
    // assignable field and the patch goes through.
    expect(results[0].success).toBe(true);
    expect(mockPrisma.negotiationLink.update).toHaveBeenCalled();
  });
});
