/**
 * track() tests — F2 revised (self-hosted Supabase ProductEvent, 2026-04-20).
 *
 * Asserts the construction-guardrails:
 *   - unknown event names throw in dev, swallow in prod
 *   - non-scalar prop values throw in dev, drop in prod
 *   - string props are truncated at 200 chars
 *   - prop keys are capped at 16
 *   - Prisma insert failures are swallowed (analytics never breaks hot path)
 *   - empty / null props collapse to null, not {}
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    productEvent: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { track } from "@/lib/analytics/track";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("track", () => {
  it("writes an allowlisted event on the happy path", async () => {
    vi.mocked(prisma.productEvent.create).mockResolvedValue({} as never);
    await track({
      name: "onboarding.phase_entered",
      userId: "u_1",
      sessionId: "s_1",
      props: { phase: "calendar" },
    });
    expect(prisma.productEvent.create).toHaveBeenCalledWith({
      data: {
        name: "onboarding.phase_entered",
        userId: "u_1",
        sessionId: "s_1",
        props: { phase: "calendar" },
      },
    });
  });

  it("throws on unknown event name in non-production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(
      track({ name: "onboarding.mystery_event" }),
    ).rejects.toThrow(/not in the allowlist/i);
    expect(prisma.productEvent.create).not.toHaveBeenCalled();
  });

  it("swallows unknown event name in production (does not crash)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(track({ name: "onboarding.mystery_event" })).resolves.toBeUndefined();
    expect(prisma.productEvent.create).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("throws on non-scalar prop value in non-production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(
      track({
        name: "feedback.report_submitted",
        // @ts-expect-error — deliberately invalid
        props: { nested: { foo: 1 } },
      }),
    ).rejects.toThrow(/non-scalar/i);
    expect(prisma.productEvent.create).not.toHaveBeenCalled();
  });

  it("drops non-scalar props in production and writes the rest", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(prisma.productEvent.create).mockResolvedValue({} as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await track({
      name: "feedback.report_submitted",
      // @ts-expect-error — deliberately invalid
      props: { good: "yes", bad: { foo: 1 } },
    });
    const call = vi.mocked(prisma.productEvent.create).mock.calls[0][0];
    expect(call.data.props).toEqual({ good: "yes" });
    errSpy.mockRestore();
  });

  it("truncates string values longer than 200 chars", async () => {
    vi.mocked(prisma.productEvent.create).mockResolvedValue({} as never);
    const big = "x".repeat(500);
    await track({ name: "confirm.succeeded", props: { note: big } });
    const call = vi.mocked(prisma.productEvent.create).mock.calls[0][0];
    const props = call.data.props as { note: string };
    expect(props.note.length).toBe(200);
  });

  it("caps prop keys at 16", async () => {
    vi.mocked(prisma.productEvent.create).mockResolvedValue({} as never);
    const props: Record<string, number> = {};
    for (let i = 0; i < 25; i += 1) props[`k${i}`] = i;
    await track({ name: "confirm.succeeded", props });
    const call = vi.mocked(prisma.productEvent.create).mock.calls[0][0];
    expect(Object.keys(call.data.props as object).length).toBe(16);
  });

  it("collapses empty/undefined props to null", async () => {
    vi.mocked(prisma.productEvent.create).mockResolvedValue({} as never);
    await track({ name: "confirm.succeeded" });
    const call = vi.mocked(prisma.productEvent.create).mock.calls[0][0];
    expect(call.data.props).toBeUndefined();
  });

  it("preserves scalar types (number, boolean, null)", async () => {
    vi.mocked(prisma.productEvent.create).mockResolvedValue({} as never);
    await track({
      name: "confirm.succeeded",
      props: { count: 3, ok: true, maybe: null },
    });
    const call = vi.mocked(prisma.productEvent.create).mock.calls[0][0];
    expect(call.data.props).toEqual({ count: 3, ok: true, maybe: null });
  });

  it("swallows Prisma insert failures (never breaks the caller)", async () => {
    vi.mocked(prisma.productEvent.create).mockRejectedValue(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      track({ name: "confirm.succeeded", props: { ok: true } }),
    ).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});
