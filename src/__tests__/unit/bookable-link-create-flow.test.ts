/**
 * Bookable Link create flow data path.
 *
 * Covers the interception → proposal → confirm round-trip:
 *
 *   1. Dispatch-handler classifies an LLM-emitted `update_availability_rule`
 *      action with `params.rule.action === "bookable"` (or legacy
 *      `"office_hours"`) and `operation === "add"` as a Bookable Link proposal
 *      (no rule write yet); other rule actions (block, location, remove, …)
 *      and non-Bookable rule actions still flow through executeActions.
 *   2. The projected payload matches the BookableLinkProposalPayload contract
 *      consumed by the confirmation card / sheet.
 *   3. POST /api/availability-rules/confirm validates auth + the
 *      persisted proposal row + the immutable originalText cross-check,
 *      then writes the rule into `User.preferences.explicit.structuredRules[]`
 *      with the same shape `handleUpdateAvailabilityRule` produces.
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

import {
  isBookableAction,
  projectProposal,
  type BookableLinkProposalPayload,
} from "@/agent/dispatch-handler";
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

  it("does NOT intercept rename_general", () => {
    expect(
      isBookableAction({
        action: "update_availability_rule",
        params: { operation: "rename_general", name: "Main" },
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

describe("projectProposal", () => {
  it("projects all fields when the LLM emits a complete payload (new bookable field)", () => {
    const out: BookableLinkProposalPayload = projectProposal({
      action: "update_availability_rule",
      params: {
        operation: "add",
        rule: {
          originalText: "Tennis team drop-in hours — weekdays 8–10am, 30-min video",
          type: "recurring",
          action: "bookable",
          daysOfWeek: [1, 2, 3, 4, 5],
          timeStart: "08:00",
          timeEnd: "10:00",
          bookable: {
            name: "Tennis team",
            format: "video",
            durationMinutes: 30,
          },
          priority: 3,
        },
      },
    });
    expect(out.title).toBe("Tennis team");
    expect(out.format).toBe("video");
    expect(out.durationMinutes).toBe(30);
    expect(out.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(out.timeStart).toBe("08:00");
    expect(out.timeEnd).toBe("10:00");
    expect(out.originalText).toContain("Tennis team");
  });

  it("falls back to safe defaults on partial payloads", () => {
    const out = projectProposal({
      action: "update_availability_rule",
      params: { operation: "add", rule: { action: "bookable" } },
    });
    expect(out.title).toBe("Drop-in Hours");
    expect(out.format).toBe("video");
    expect(out.durationMinutes).toBe(30);
    expect(out.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out.timeStart).toBe("09:00");
    expect(out.timeEnd).toBe("17:00");
  });

  it("rejects out-of-range daysOfWeek and falls back when empty", () => {
    const out = projectProposal({
      action: "update_availability_rule",
      params: {
        operation: "add",
        rule: {
          action: "bookable",
          daysOfWeek: [-1, 7, 8, "monday"],
          bookable: { name: "Coaching" },
        },
      },
    });
    // All entries filtered → falls back to all-week default.
    expect(out.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("normalizes format and duration to safe values", () => {
    const out = projectProposal({
      action: "update_availability_rule",
      params: {
        operation: "add",
        rule: {
          action: "bookable",
          bookable: {
            name: "Sales pitch",
            // bogus values — should normalize back to defaults
            format: "carrier-pigeon",
            durationMinutes: 7,
          },
        },
      },
    });
    expect(out.format).toBe("video");
    expect(out.durationMinutes).toBe(30);
  });
});

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
