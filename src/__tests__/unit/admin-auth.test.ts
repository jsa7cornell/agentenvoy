/**
 * admin-auth gate tests — F1 of the feedback-loops proposal (2026-04-20).
 *
 * The gate swapped from ADMIN_EMAIL-only to `User.userClass === "admin"`
 * with a 24-48h env-var fallback. Asserts:
 *   - userClass === "admin" passes the gate (authoritative path)
 *   - userClass === "user" + email matches ADMIN_EMAIL → passes (fallback)
 *   - userClass === "user" + non-matching email → fails (404/false)
 *   - no session → fails (redirect for pages, false for API)
 *   - email casing is normalized when matching the env-var fallback
 *
 * The fallback path will be removed in the very next PR once this ships
 * and John's row is confirmed flipped to "admin".
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
  process.env.ADMIN_EMAIL = "jsa7cornell@gmail.com";
});

async function load() {
  // Re-import under each test so module-level ADMIN_EMAIL picks up env changes.
  vi.resetModules();
  return import("@/lib/admin-auth");
}

describe("isAdminSession", () => {
  it("returns true when userClass is 'admin' (authoritative path)", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "anyone@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      userClass: "admin",
    } as never);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(true);
  });

  it("returns true on env-var fallback when userClass is 'user' but email matches ADMIN_EMAIL", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "jsa7cornell@gmail.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      userClass: "user",
    } as never);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(true);
  });

  it("normalizes email casing when matching the env-var fallback", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "JSA7cornell@GMAIL.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      userClass: "user",
    } as never);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(true);
  });

  it("returns false when userClass is 'user' and email does not match ADMIN_EMAIL", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "nobody@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      userClass: "user",
    } as never);

    const { isAdminSession } = await load();
    expect(await isAdminSession()).toBe(false);
  });

  it("returns false when User row is missing and email does not match ADMIN_EMAIL", async () => {
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
    // No DB lookup performed when there's no email to key on.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns false when there is no session at all", async () => {
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
      userClass: "admin",
    } as never);

    const { requireAdminPage } = await load();
    await expect(requireAdminPage()).resolves.toBe("admin@example.com");
  });

  it("calls notFound() when authenticated but userClass is 'user' and email does not match fallback", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: "nobody@example.com" },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
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
