/**
 * logAdminAccess tests — F5 of the feedback-loops proposal (2026-04-20).
 *
 * Asserts:
 *   - happy path writes a row with the expected shape
 *   - /admin/access-log is exempt (meta-log loop avoidance)
 *   - invalid action throws in dev, coerces to "view" in prod
 *   - Prisma insert failures are swallowed (audit miss is better than 500)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// vi.stubEnv is the supported way to mutate readonly env keys (NODE_ENV) inside tests.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    adminAccessLog: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { logAdminAccess } from "@/lib/admin/access-log";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("logAdminAccess", () => {
  it("writes a row on the happy path", async () => {
    vi.mocked(prisma.adminAccessLog.create).mockResolvedValue({} as never);
    await logAdminAccess({
      adminId: "u_admin",
      path: "/admin/failures",
      action: "list",
    });
    expect(prisma.adminAccessLog.create).toHaveBeenCalledWith({
      data: {
        adminId: "u_admin",
        path: "/admin/failures",
        action: "list",
        targetUserId: null,
        contextJson: null,
      },
    });
  });

  it("writes context when provided", async () => {
    vi.mocked(prisma.adminAccessLog.create).mockResolvedValue({} as never);
    await logAdminAccess({
      adminId: "u_admin",
      path: "/admin/feedback/:id",
      action: "view",
      targetUserId: "u_target",
      context: { feedbackReportId: "fr_1" },
    });
    const call = vi.mocked(prisma.adminAccessLog.create).mock.calls[0][0];
    expect(call.data.targetUserId).toBe("u_target");
    expect(call.data.contextJson).toEqual({ feedbackReportId: "fr_1" });
  });

  it("short-circuits on /admin/access-log (exempt path)", async () => {
    await logAdminAccess({
      adminId: "u_admin",
      path: "/admin/access-log",
      action: "list",
    });
    expect(prisma.adminAccessLog.create).not.toHaveBeenCalled();
  });

  it("throws on invalid action in non-production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(
      logAdminAccess({
        adminId: "u_admin",
        path: "/admin/failures",
        // @ts-expect-error — deliberately invalid
        action: "veiw",
      }),
    ).rejects.toThrow(/invalid action/i);
    expect(prisma.adminAccessLog.create).not.toHaveBeenCalled();
  });

  it("coerces invalid action to 'view' in production (never drop audit row)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(prisma.adminAccessLog.create).mockResolvedValue({} as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await logAdminAccess({
      adminId: "u_admin",
      path: "/admin/failures",
      // @ts-expect-error — deliberately invalid
      action: "veiw",
    });
    expect(prisma.adminAccessLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "view" }),
    });
    errSpy.mockRestore();
  });

  it("swallows Prisma failures (audit miss is better than HTTP 500)", async () => {
    vi.mocked(prisma.adminAccessLog.create).mockRejectedValue(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      logAdminAccess({
        adminId: "u_admin",
        path: "/admin/failures",
        action: "list",
      }),
    ).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});
