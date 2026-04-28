/**
 * Phase 1 PR 7 — Office Hours edit endpoint.
 *
 * Endpoint under test: POST /api/availability-rules/edit. Companion to
 * `/api/availability-rules/confirm` (PR 5) — that one CREATES a rule from
 * a chat-flow proposal; this one UPDATES an existing rule's editable
 * parameters from the Event Links sheet's Edit dialog. Immutable fields
 * (`linkSlug` / `linkCode`) are preserved across the write.
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
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    // Reusable-link guest-picks proposal (decided 2026-04-28) added a
    // clear-on-edit step in the route — null `negotiatedDuration` /
    // `negotiatedFormat` on active sessions when the host changes the rule's
    // duration / format. Tests don't assert on this call directly; the mock
    // just prevents `Cannot read properties of undefined (reading 'updateMany')`.
    negotiationSession: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

vi.mock("@/lib/calendar", () => ({
  invalidateSchedule: vi.fn(async () => undefined),
}));

vi.mock("@/lib/profile-gaps", () => ({
  invalidateBehaviorSnapshot: vi.fn(),
}));

import { POST as editPOST } from "@/app/api/availability-rules/edit/route";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";
import { invalidateBehaviorSnapshot } from "@/lib/profile-gaps";

const USER_ID = "user_host";
const RULE_ID = "rule_existing";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/availability-rules/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_EDIT = {
  title: "Guitar students v2",
  format: "video" as const,
  durationMinutes: 45,
  daysOfWeek: [1, 2, 3, 4, 5],
  timeStart: "10:00",
  timeEnd: "16:00",
};

const EXISTING_RULE = {
  id: RULE_ID,
  originalText: "guitar students every weekday 9–5, 30 min slots",
  type: "recurring" as const,
  action: "office_hours" as const,
  timeStart: "09:00",
  timeEnd: "17:00",
  daysOfWeek: [1, 2, 3, 4, 5],
  officeHours: {
    name: "Guitar students",
    title: "Guitar students",
    format: "video" as const,
    durationMinutes: 30,
    linkSlug: "jane",
    linkCode: "code1234",
  },
  status: "active" as const,
  priority: 3,
  createdAt: "2026-04-20T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/availability-rules/edit", () => {
  it("rejects with 401 when unauthenticated", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await editPOST(
      makeRequest({ ruleId: RULE_ID, proposal: VALID_EDIT }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("rejects with 400 when ruleId is missing", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    const res = await editPOST(makeRequest({ proposal: VALID_EDIT }) as never);
    expect(res.status).toBe(400);
  });

  it("rejects with 400 on invalid proposal (empty title)", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    const res = await editPOST(
      makeRequest({ ruleId: RULE_ID, proposal: { ...VALID_EDIT, title: "" } }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects with 400 when timeStart >= timeEnd", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    const res = await editPOST(
      makeRequest({
        ruleId: RULE_ID,
        proposal: { ...VALID_EDIT, timeStart: "17:00", timeEnd: "10:00" },
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects with 404 when the user has no preferences", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await editPOST(
      makeRequest({ ruleId: RULE_ID, proposal: VALID_EDIT }) as never,
    );
    expect(res.status).toBe(404);
  });

  it("rejects with 404 when the rule isn't in the user's structuredRules", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [] } },
    });
    const res = await editPOST(
      makeRequest({ ruleId: RULE_ID, proposal: VALID_EDIT }) as never,
    );
    expect(res.status).toBe(404);
  });

  it("rejects with 400 when the rule is not an Office Hours rule", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: {
        explicit: {
          structuredRules: [
            {
              id: RULE_ID,
              action: "block",
              status: "active",
              type: "recurring",
              priority: 3,
              originalText: "block lunch",
              createdAt: "2026-04-20T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const res = await editPOST(
      makeRequest({ ruleId: RULE_ID, proposal: VALID_EDIT }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects with 409 on per-host name collision against another rule", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: {
        explicit: {
          structuredRules: [
            EXISTING_RULE,
            {
              ...EXISTING_RULE,
              id: "rule_other",
              officeHours: {
                ...EXISTING_RULE.officeHours,
                name: "Sales Pitch",
              },
            },
          ],
        },
      },
    });
    const res = await editPOST(
      makeRequest({
        ruleId: RULE_ID,
        proposal: { ...VALID_EDIT, title: "Sales Pitch" },
      }) as never,
    );
    expect(res.status).toBe(409);
  });

  it("allows renaming a rule to its own current name (excludes self from uniqueness check)", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: {
        explicit: {
          structuredRules: [EXISTING_RULE],
        },
      },
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const res = await editPOST(
      makeRequest({
        ruleId: RULE_ID,
        proposal: { ...VALID_EDIT, title: "Guitar students" },
      }) as never,
    );
    expect(res.status).toBe(200);
  });

  it("updates editable fields and preserves linkSlug + linkCode", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: {
        explicit: {
          structuredRules: [EXISTING_RULE],
        },
      },
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await editPOST(
      makeRequest({ ruleId: RULE_ID, proposal: VALID_EDIT }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ruleId).toBe(RULE_ID);

    const updateCall = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls[0];
    const rules = (
      updateCall[0].data.preferences as {
        explicit: { structuredRules: Array<Record<string, unknown>> };
      }
    ).explicit.structuredRules;
    expect(rules).toHaveLength(1);
    const updated = rules[0];
    expect(updated.id).toBe(RULE_ID);
    expect(updated.timeStart).toBe("10:00");
    expect(updated.timeEnd).toBe("16:00");
    expect(updated.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    const oh = updated.officeHours as Record<string, unknown>;
    expect(oh.name).toBe("Guitar students v2");
    expect(oh.title).toBe("Guitar students v2");
    expect(oh.format).toBe("video");
    expect(oh.durationMinutes).toBe(45);
    // Immutable — must be preserved.
    expect(oh.linkSlug).toBe("jane");
    expect(oh.linkCode).toBe("code1234");

    expect(invalidateSchedule).toHaveBeenCalledWith(USER_ID);
    expect(invalidateBehaviorSnapshot).toHaveBeenCalledWith(USER_ID);
  });

  it("does not collide with the host's Primary link name (generalLinkName)", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID },
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: {
        explicit: {
          generalLinkName: "Jane Doe",
          structuredRules: [EXISTING_RULE],
        },
      },
    });
    const res = await editPOST(
      makeRequest({
        ruleId: RULE_ID,
        proposal: { ...VALID_EDIT, title: "Jane Doe" },
      }) as never,
    );
    expect(res.status).toBe(409);
  });
});
