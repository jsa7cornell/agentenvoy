/**
 * Bookable Link create flow data path.
 *
 * Covers two surfaces:
 *
 *   1. `isBookableAction` (moved to `modules/_shared/bookable.ts` in PR2)
 *      classifies LLM-emitted `update_availability_rule` actions with
 *      `params.rule.action === "bookable"` and `operation === "add"` so the
 *      route can tag the persisted envoy turn's metadata with
 *      `linkKind: "bookable"`.
 *   2. POST /api/availability-rules/confirm continues to validate auth +
 *      the persisted proposal row + the immutable originalText cross-check
 *      for any in-flight `rule_proposal` rows that predate the 2026-05-03
 *      chat-driven reshape. New traffic does not exercise this path.
 *
 * Vocabulary: this test exercises the **Bookable Link** feature — code
 * keyword `r.action === "bookable"`. It does NOT touch
 * `User.preferences.explicit.businessHoursStart` / `businessHoursEnd`,
 * which are the host's daily window (**Business hours**) and unrelated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    channelMessage: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    channel: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/utils", () => ({
  generateCode: () => "code1234",
}));

vi.mock("@/lib/calendar", () => ({
  invalidateSchedule: vi.fn(async () => undefined),
}));

vi.mock("@/lib/profile-gaps", () => ({
  invalidateBehaviorSnapshot: vi.fn(),
}));

import { isBookableAction } from "@/agent/modules/_shared/bookable";
import { POST as confirmPOST } from "@/app/api/availability-rules/confirm/route";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";
import { invalidateBehaviorSnapshot } from "@/lib/profile-gaps";

const USER_ID = "user_host";
const PROPOSAL_MSG_ID = "msg_proposal";
const MEET_SLUG = "jane";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/availability-rules/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_PROPOSAL = {
  originalText: "create link for guitar students every day at 2:00–5:00, 30 min slots",
  title: "Guitar students",
  format: "video" as const,
  durationMinutes: 30,
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  timeStart: "14:00",
  timeEnd: "17:00",
  effectiveDate: "2026-04-26",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Interception classifier ────────────────────────────────────────────────

describe("isBookableAction", () => {
  it("classifies update_availability_rule + bookable + add as intercepted", () => {
    expect(
      isBookableAction({
        action: "update_availability_rule",
        params: { operation: "add", rule: { action: "bookable" } },
      }),
    ).toBe(true);
  });

  it("does NOT intercept update_availability_rule with action=block", () => {
    expect(
      isBookableAction({
        action: "update_availability_rule",
        params: {
          operation: "add",
          rule: { action: "block", timeStart: "14:00", timeEnd: "16:00" },
        },
      }),
    ).toBe(false);
  });

  it("does NOT intercept update_availability_rule with action=location", () => {
    expect(
      isBookableAction({
        action: "update_availability_rule",
        params: { operation: "add", rule: { action: "location", locationLabel: "Baja" } },
      }),
    ).toBe(false);
  });

  it("does NOT intercept bookable UPDATE (only ADD is intercepted)", () => {
    expect(
      isBookableAction({
        action: "update_availability_rule",
        params: { operation: "update", id: "rule_xyz", rule: { action: "bookable" } },
      }),
    ).toBe(false);
  });

  it("does NOT intercept rename_primary", () => {
    expect(
      isBookableAction({
        action: "update_availability_rule",
        params: { operation: "rename_primary", name: "Main" },
      }),
    ).toBe(false);
  });

  it("does NOT intercept other action types (archive, create_link, …)", () => {
    expect(
      isBookableAction({ action: "archive", params: { sessionId: "sess1" } }),
    ).toBe(false);
    expect(
      isBookableAction({
        action: "create_link",
        params: { inviteeName: "Bryan" },
      }),
    ).toBe(false);
    expect(
      isBookableAction({
        action: "update_business_hours",
        params: { businessHoursStart: 9, businessHoursEnd: 17 },
      }),
    ).toBe(false);
  });
});

// `projectProposal` + `BookableLinkProposalPayload` were retired with the
// 2026-05-03 chat-driven narration reshape (proposal `2026-05-03_recurring-
// and-office-hours-widgets` §3.8). Bookable rule writes now flow through
// `executeActions` like every other rule action; the propose-then-confirm
// shape is gone from the runtime path. Tests for those helpers were
// removed alongside the helpers in PR2.

// ─── /api/availability-rules/confirm round-trip ─────────────────────────────

describe("POST /api/availability-rules/confirm", () => {
  it("rejects with 401 when unauthenticated", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await confirmPOST(
      makeRequest({ proposalMessageId: PROPOSAL_MSG_ID, proposal: VALID_PROPOSAL }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("rejects with 400 on missing proposalMessageId", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    const res = await confirmPOST(makeRequest({ proposal: VALID_PROPOSAL }) as never);
    expect(res.status).toBe(400);
  });

  it("rejects with 400 on invalid proposal body (missing title)", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    const res = await confirmPOST(
      makeRequest({
        proposalMessageId: PROPOSAL_MSG_ID,
        proposal: { ...VALID_PROPOSAL, title: "" },
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects with 400 when timeStart >= timeEnd", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    const res = await confirmPOST(
      makeRequest({
        proposalMessageId: PROPOSAL_MSG_ID,
        proposal: { ...VALID_PROPOSAL, timeStart: "17:00", timeEnd: "14:00" },
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects with 404 when the proposal row doesn't exist", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.channelMessage.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await confirmPOST(
      makeRequest({ proposalMessageId: PROPOSAL_MSG_ID, proposal: VALID_PROPOSAL }) as never,
    );
    expect(res.status).toBe(404);
  });

  it("rejects with 403 when the proposal belongs to a different user", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.channelMessage.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PROPOSAL_MSG_ID,
      role: "system",
      metadata: {
        kind: "rule_proposal",
        proposal: VALID_PROPOSAL,
      },
      channel: { userId: "someone-else" },
    });
    const res = await confirmPOST(
      makeRequest({ proposalMessageId: PROPOSAL_MSG_ID, proposal: VALID_PROPOSAL }) as never,
    );
    expect(res.status).toBe(403);
  });

  it("rejects with 409 when originalText was tampered", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.channelMessage.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PROPOSAL_MSG_ID,
      role: "system",
      metadata: {
        kind: "rule_proposal",
        proposal: { ...VALID_PROPOSAL, originalText: "ORIGINAL TEXT FROM LLM" },
      },
      channel: { userId: USER_ID },
    });
    const res = await confirmPOST(
      makeRequest({
        proposalMessageId: PROPOSAL_MSG_ID,
        proposal: { ...VALID_PROPOSAL, originalText: "DIFFERENT TEXT" },
      }) as never,
    );
    expect(res.status).toBe(409);
  });

  it("rejects with 409 when the proposal was already confirmed", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.channelMessage.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PROPOSAL_MSG_ID,
      role: "system",
      metadata: {
        kind: "rule_proposal",
        confirmed: true,
        proposal: VALID_PROPOSAL,
      },
      channel: { userId: USER_ID },
    });
    const res = await confirmPOST(
      makeRequest({ proposalMessageId: PROPOSAL_MSG_ID, proposal: VALID_PROPOSAL }) as never,
    );
    expect(res.status).toBe(409);
  });

  it("writes the bookable rule into preferences.explicit.structuredRules[] on success", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.channelMessage.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PROPOSAL_MSG_ID,
      role: "system",
      metadata: {
        kind: "rule_proposal",
        proposal: VALID_PROPOSAL,
      },
      channel: { userId: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [] } },
      meetSlug: MEET_SLUG,
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.channelMessage.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.channel.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "channel_1",
    });
    (prisma.channelMessage.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await confirmPOST(
      makeRequest({
        proposalMessageId: PROPOSAL_MSG_ID,
        proposal: VALID_PROPOSAL,
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ruleId).toMatch(/^rule_/);
    expect(body.linkUrl).toContain(`/meet/${MEET_SLUG}/`);

    // Verify the rule shape we wrote — must mirror handleUpdateAvailabilityRule.
    const updateCall = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall).toBeDefined();
    const data = updateCall[0].data;
    const rules = (data.preferences as { explicit: { structuredRules: unknown[] } }).explicit
      .structuredRules;
    expect(rules).toHaveLength(1);
    const rule = rules[0] as Record<string, unknown>;
    expect(rule.action).toBe("bookable");
    expect(rule.type).toBe("recurring");
    expect(rule.timeStart).toBe("14:00");
    expect(rule.timeEnd).toBe("17:00");
    expect(rule.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rule.status).toBe("active");
    const bl = rule.bookable as Record<string, unknown>;
    expect(bl.name).toBe("Guitar students");
    expect(bl.title).toBe("Guitar students");
    expect(bl.format).toBe("video");
    expect(bl.durationMinutes).toBe(30);
    expect(bl.linkSlug).toBe(MEET_SLUG);
    expect(typeof bl.linkCode).toBe("string");

    // Verify side-effects: schedule invalidated + behavior snapshot bumped +
    // proposal row marked confirmed + confirmation row appended.
    expect(invalidateSchedule).toHaveBeenCalledWith(USER_ID);
    expect(invalidateBehaviorSnapshot).toHaveBeenCalledWith(USER_ID);
    expect(prisma.channelMessage.update).toHaveBeenCalled();
    const updateMetaArg = (prisma.channelMessage.update as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(updateMetaArg.where.id).toBe(PROPOSAL_MSG_ID);
    expect((updateMetaArg.data.metadata as Record<string, unknown>).confirmed).toBe(true);
  });

  it("rejects with 409 on per-host name collision", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.channelMessage.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PROPOSAL_MSG_ID,
      role: "system",
      metadata: { kind: "rule_proposal", proposal: VALID_PROPOSAL },
      channel: { userId: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: {
        explicit: {
          structuredRules: [
            {
              id: "rule_existing",
              action: "bookable",
              status: "active",
              bookable: {
                name: "Guitar students",
                title: "Guitar students",
                format: "video",
                durationMinutes: 30,
                linkSlug: MEET_SLUG,
                linkCode: "code0001",
              },
            },
          ],
        },
      },
      meetSlug: MEET_SLUG,
    });
    const res = await confirmPOST(
      makeRequest({ proposalMessageId: PROPOSAL_MSG_ID, proposal: VALID_PROPOSAL }) as never,
    );
    expect(res.status).toBe(409);
  });
});
