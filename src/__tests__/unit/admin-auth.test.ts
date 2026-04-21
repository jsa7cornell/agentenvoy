/**
 * admin-auth gate tests — F1 of the feedback-loops proposal (2026-04-20).
 *
 * Gate: `User.userClass === "admin"`. The 24-48h `ADMIN_EMAIL` env-var
 * fallback that shipped with F1 was removed in the follow-up PR (#24);
 * tests assert the single-path behavior:
 *   - userClass === "admin" passes
 *   - userClass === "user" fails (404/false)
 *   - User row missing fails (404/false)
 *   - no session fails (redirect for pages, false for API)
 *   - requireAdminContext returns { id, email } for admins
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
    },
  },
}));

const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
  notFound: () => notFoundMock(),
  redirect: (url: string) => redirectMock(url),
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

beforeEach(() => {
  vi.clearAllMocks();
});

async function load() {
  vi.resetModules();
  return import("@/lib/admin-auth");
}

describe("isAdminSession", () => {
  it("returns true when userClass is 'admin'", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "admin@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u_admin",
      email: "admin@example.com",
      userClass: "admin",
    } as never);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(true);
  });

  it("returns false when userClass is 'user'", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "nobody@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u_nobody",
      email: "nobody@example.com",
      userClass: "user",
    } as never);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(false);
  });

  it("returns false when User row is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "ghost@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(false);
  });

  it("returns false when session has no email", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: {} } as never);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns false when there is no session", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(false);
  });
});

describe("requireAdminPage", () => {
  it("returns the email on admin success", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "admin@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u_admin",
      email: "admin@example.com",
      userClass: "admin",
    } as never);

    const { requireAdminPage } = await load();
    await expect(requireAdminPage()).resolves.toBe("admin@example.com");
  });

  it("calls notFound() when authenticated but userClass is 'user'", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "nobody@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u_nobody",
      email: "nobody@example.com",
      userClass: "user",
    } as never);

    const { requireAdminPage } = await load();
    await expect(requireAdminPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("redirects to /api/auth/signin with callbackUrl when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const { requireAdminPage } = await load();
    await expect(requireAdminPage("/admin/failures")).rejects.toThrow(
      /NEXT_REDIRECT:\/api\/auth\/signin\?callbackUrl=%2Fadmin%2Ffailures/,
    );
  });
});

describe("requireAdminContext", () => {
  it("returns { id, email } on admin success", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "admin@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u_admin",
      email: "admin@example.com",
      userClass: "admin",
    } as never);

    const { requireAdminContext } = await load();
    await expect(requireAdminContext()).resolves.toEqual({
      id: "u_admin",
      email: "admin@example.com",
    });
  });

  it("calls notFound() when userClass is 'user'", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "nobody@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u_nobody",
      email: "nobody@example.com",
      userClass: "user",
    } as never);

    const { requireAdminContext } = await load();
    await expect(requireAdminContext()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
