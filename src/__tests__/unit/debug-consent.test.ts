/**
 * debug-consent helpers — F4 of the feedback-loops proposal (2026-04-20).
 *
 * Asserts:
 *   - getDebugConsent returns shape + defaults safely on missing user
 *   - setDebugConsent(granted=true) stamps debugConsentAt, not revokedAt
 *   - setDebugConsent(granted=false) stamps debugConsentRevokedAt
 *   - No-op transition preserves original timestamps (we don't re-stamp)
 *   - setDebugConsent throws on unknown user
 *   - loadConsentedTarget returns the user only when debugConsent=true
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  getDebugConsent,
  setDebugConsent,
  loadConsentedTarget,
} from "@/lib/debug-consent";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDebugConsent", () => {
  it("returns the current state", async () => {
    const at = new Date("2026-04-21T12:00:00Z");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      debugConsent: true,
      debugConsentAt: at,
      debugConsentRevokedAt: null,
    } as never);
    const state = await getDebugConsent("u_1");
    expect(state).toEqual({ granted: true, grantedAt: at, revokedAt: null });
  });

  it("returns all-false on unknown user (no throw)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const state = await getDebugConsent("u_missing");
    expect(state).toEqual({ granted: false, grantedAt: null, revokedAt: null });
  });
});

describe("setDebugConsent", () => {
  it("granting stamps debugConsentAt and leaves revokedAt untouched", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      debugConsent: false,
      debugConsentAt: null,
      debugConsentRevokedAt: null,
    } as never);
    const now = new Date("2026-04-21T12:00:00Z");
    vi.mocked(prisma.user.update).mockResolvedValue({
      debugConsent: true,
      debugConsentAt: now,
      debugConsentRevokedAt: null,
    } as never);

    const state = await setDebugConsent({ userId: "u_1", granted: true, now });
    expect(state.granted).toBe(true);
    expect(state.grantedAt).toEqual(now);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u_1" },
      data: { debugConsent: true, debugConsentAt: now },
      select: expect.any(Object),
    });
  });

  it("revoking stamps debugConsentRevokedAt and preserves grantedAt", async () => {
    const grantedAt = new Date("2026-04-20T12:00:00Z");
    const now = new Date("2026-04-21T12:00:00Z");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      debugConsent: true,
      debugConsentAt: grantedAt,
      debugConsentRevokedAt: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      debugConsent: false,
      debugConsentAt: grantedAt,
      debugConsentRevokedAt: now,
    } as never);

    const state = await setDebugConsent({ userId: "u_1", granted: false, now });
    expect(state.granted).toBe(false);
    expect(state.grantedAt).toEqual(grantedAt);
    expect(state.revokedAt).toEqual(now);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u_1" },
      data: { debugConsent: false, debugConsentRevokedAt: now },
      select: expect.any(Object),
    });
  });

  it("no-op when the target state matches current — does not re-stamp", async () => {
    const grantedAt = new Date("2026-04-20T12:00:00Z");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      debugConsent: true,
      debugConsentAt: grantedAt,
      debugConsentRevokedAt: null,
    } as never);

    const state = await setDebugConsent({
      userId: "u_1",
      granted: true,
      now: new Date("2026-04-21T12:00:00Z"),
    });
    expect(state.grantedAt).toEqual(grantedAt);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("throws on unknown user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    await expect(
      setDebugConsent({ userId: "u_missing", granted: true }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("loadConsentedTarget", () => {
  it("returns id+email when consented", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u_1",
      email: "danny@example.com",
      debugConsent: true,
    } as never);
    const target = await loadConsentedTarget("u_1");
    expect(target).toEqual({ id: "u_1", email: "danny@example.com" });
  });

  it("returns null when not consented", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "u_1",
      email: "danny@example.com",
      debugConsent: false,
    } as never);
    const target = await loadConsentedTarget("u_1");
    expect(target).toBeNull();
  });

  it("returns null on unknown user (same shape as non-consent — admin can't distinguish)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const target = await loadConsentedTarget("u_missing");
    expect(target).toBeNull();
  });
});
