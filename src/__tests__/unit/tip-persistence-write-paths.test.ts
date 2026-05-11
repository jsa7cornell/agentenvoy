/**
 * Tip persistence write-path tests — punch-list #16.
 *
 * Verifies that the `tip` field actually flows end-to-end through both
 * write paths without being silently dropped:
 *
 *   1. PRIMARY path: POST /api/me/scheduling-defaults → user.preferences.explicit.tip
 *   2. VARIANCE path: PATCH /api/me/links/[id]/posture → link.parameters.tip
 *
 * All tests are pure unit tests (mocked Prisma + mocked next-auth). No DB
 * connection required. Rule 24 / PLAYBOOK DB-safety: never run integration
 * tests without verifying POSTGRES_PRISMA_URL is local.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

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
    negotiationLink: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/calendar", () => ({
  invalidateSchedule: vi.fn().mockResolvedValue(undefined),
}));

// applyPostureToScope is called by the PATCH /posture handler for non-tip fields.
vi.mock("@/lib/links/scope", () => ({
  applyPostureToScope: vi.fn().mockResolvedValue({ varianceWrites: 0 }),
}));

// getLinkPosture is used by the GET; not needed here but mock to avoid import errors.
vi.mock("@/lib/links/posture", () => ({
  getLinkPosture: vi.fn().mockReturnValue({}),
}));

// link-parameters is imported dynamically inside the PATCH handler for tip writes.
vi.mock("@/lib/link-parameters", () => ({
  parseLinkParameters: vi.fn((v: Record<string, unknown>) => v ?? {}),
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, urlParams?: Record<string, string>): Request {
  const url = urlParams?.id
    ? `http://localhost/api/me/links/${urlParams.id}/posture`
    : "http://localhost/api/me/scheduling-defaults";
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePatchRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/me/links/${id}/posture`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const MOCK_USER_ID = "user_test_123";
const MOCK_SESSION = { user: { id: MOCK_USER_ID } };

// ── PRIMARY PATH tests — POST /api/me/scheduling-defaults ─────────────────────

describe("Primary write path: POST /api/me/scheduling-defaults — tip field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      preferences: {},
      meetSlug: "john",
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  });

  it("writes tip to preferences.explicit.tip when tip is provided", async () => {
    const { POST } = await import(
      "@/app/api/me/scheduling-defaults/route"
    );

    const req = makeRequest({
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1080,
      tip: "Looking forward to our chat!",
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    // Verify prisma.user.update was called with tip in the explicit preferences
    expect(prisma.user.update).toHaveBeenCalledOnce();
    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0];
    const updatedPrefs = updateCall.data.preferences as {
      explicit?: { tip?: string };
    };
    expect(updatedPrefs.explicit?.tip).toBe("Looking forward to our chat!");
  });

  it("trims whitespace from tip before writing", async () => {
    const { POST } = await import(
      "@/app/api/me/scheduling-defaults/route"
    );

    const req = makeRequest({
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1080,
      tip: "  Trimmed tip  ",
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0];
    const updatedPrefs = updateCall.data.preferences as {
      explicit?: { tip?: string };
    };
    expect(updatedPrefs.explicit?.tip).toBe("Trimmed tip");
  });

  it("writes null to preferences.explicit.tip when tip is empty string (clear)", async () => {
    const { POST } = await import(
      "@/app/api/me/scheduling-defaults/route"
    );

    const req = makeRequest({
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1080,
      tip: "",
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0];
    const updatedPrefs = updateCall.data.preferences as {
      explicit?: { tip?: string | null };
    };
    expect(updatedPrefs.explicit?.tip).toBeNull();
  });

  it("does not touch tip in preferences when tip is absent from payload", async () => {
    // Pre-existing tip should be preserved (not wiped) when the POST
    // omits the tip field entirely.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      preferences: { explicit: { tip: "Old tip from before" } },
      meetSlug: "john",
    } as never);

    const { POST } = await import(
      "@/app/api/me/scheduling-defaults/route"
    );

    const req = makeRequest({
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1080,
      // No tip field — should be a no-op for tip
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0];
    const updatedPrefs = updateCall.data.preferences as {
      explicit?: { tip?: string };
    };
    // The old tip should be preserved because tip=undefined means "don't touch"
    expect(updatedPrefs.explicit?.tip).toBe("Old tip from before");
  });

  it("rejects tip over 280 chars as null (does not crash)", async () => {
    const { POST } = await import(
      "@/app/api/me/scheduling-defaults/route"
    );

    const req = makeRequest({
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1080,
      tip: "a".repeat(281),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0];
    const updatedPrefs = updateCall.data.preferences as {
      explicit?: { tip?: string | null };
    };
    // Over-length tip is stored as null (cleared), not the raw string
    expect(updatedPrefs.explicit?.tip).toBeNull();
  });
});

// ── VARIANCE PATH tests — PATCH /api/me/links/[id]/posture ───────────────────

describe("Variance write path: PATCH /api/me/links/[id]/posture — tip field", () => {
  const MOCK_LINK_ID = "link_abc_123";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
    // findFirst is used by findLink() helper inside the handler
    vi.mocked(prisma.negotiationLink.findFirst).mockResolvedValue({
      id: MOCK_LINK_ID,
      userId: MOCK_USER_ID,
      parameters: {},
    } as never);
    // findUnique is used to fetch existing parameters before the tip write
    vi.mocked(prisma.negotiationLink.findUnique).mockResolvedValue({
      id: MOCK_LINK_ID,
      parameters: {},
    } as never);
    vi.mocked(prisma.negotiationLink.update).mockResolvedValue({} as never);
  });

  it("writes tip to link.parameters.tip when tip is provided", async () => {
    const { PATCH } = await import(
      "@/app/api/me/links/[id]/posture/route"
    );

    const req = makePatchRequest(MOCK_LINK_ID, {
      tip: "Great to meet you!",
    });

    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: MOCK_LINK_ID }),
    });
    expect(res.status).toBe(200);

    // negotiationLink.update should have been called with tip in parameters
    expect(prisma.negotiationLink.update).toHaveBeenCalledOnce();
    const updateCall = vi.mocked(prisma.negotiationLink.update).mock.calls[0][0];
    const updatedParams = updateCall.data.parameters as { tip?: string };
    expect(updatedParams.tip).toBe("Great to meet you!");
  });

  it("trims whitespace from tip before writing to link.parameters", async () => {
    const { PATCH } = await import(
      "@/app/api/me/links/[id]/posture/route"
    );

    const req = makePatchRequest(MOCK_LINK_ID, {
      tip: "  Padded  ",
    });

    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: MOCK_LINK_ID }),
    });
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(prisma.negotiationLink.update).mock.calls[0][0];
    const updatedParams = updateCall.data.parameters as { tip?: string };
    expect(updatedParams.tip).toBe("Padded");
  });

  it("removes tip key from link.parameters when tip is empty string (clear)", async () => {
    // Pre-existing parameters with a tip
    vi.mocked(prisma.negotiationLink.findUnique).mockResolvedValue({
      id: MOCK_LINK_ID,
      parameters: { tip: "Old tip" },
    } as never);

    const { PATCH } = await import(
      "@/app/api/me/links/[id]/posture/route"
    );

    const req = makePatchRequest(MOCK_LINK_ID, {
      tip: "",
    });

    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: MOCK_LINK_ID }),
    });
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(prisma.negotiationLink.update).mock.calls[0][0];
    const updatedParams = updateCall.data.parameters as { tip?: string };
    // tip key should be absent (deleted) when cleared
    expect(updatedParams.tip).toBeUndefined();
  });

  it("rejects tip over 280 chars with 400", async () => {
    const { PATCH } = await import(
      "@/app/api/me/links/[id]/posture/route"
    );

    const req = makePatchRequest(MOCK_LINK_ID, {
      tip: "b".repeat(281),
    });

    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: MOCK_LINK_ID }),
    });
    expect(res.status).toBe(400);

    // No DB write should occur
    expect(prisma.negotiationLink.update).not.toHaveBeenCalled();
  });

  it("returns 404 when link is not owned by the caller", async () => {
    vi.mocked(prisma.negotiationLink.findFirst).mockResolvedValue(null);

    const { PATCH } = await import(
      "@/app/api/me/links/[id]/posture/route"
    );

    const req = makePatchRequest("link_other_user", {
      tip: "Tip for someone else's link",
    });

    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: "link_other_user" }),
    });
    expect(res.status).toBe(404);
    expect(prisma.negotiationLink.update).not.toHaveBeenCalled();
  });
});
