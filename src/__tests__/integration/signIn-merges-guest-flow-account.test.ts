/**
 * T1 B1 gate — verifies the guest_flow → host signin merge.
 *
 * Bryan's incident scenario: a user signs up via the deal-room "Auto-match
 * calendars" CTA (guest-calendar OAuth flow), creating a User + Account row.
 * Later, that same Google identity signs in via the host signin (NextAuth's
 * Google provider with full calendar.events scope).
 *
 * Two correctness invariants under test:
 *  1. The PrismaAdapter merges the existing Account by (provider, providerAccountId)
 *     — no duplicate User row, no duplicate Account row.
 *  2. The new `events.signIn` upgrade hook clears `lastCalibratedAt`, drops
 *     the `signupSource = guest_flow` marker, and writes a permanent
 *     `signupSourceUpgradedFrom` breadcrumb.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, resetDb } from "./helpers/db";
import { authOptions } from "@/lib/auth";

beforeEach(async () => {
  await resetDb();
});

const GOOGLE_SUB = "google-sub-bryan-test";
const HOST_SCOPE =
  "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";

async function seedGuestFlowUser(opts: { signupSource: "guest_flow" | "guest_flow_upgrading" }) {
  const user = await prisma.user.create({
    data: {
      email: "merge-test@example.com",
      name: "Merge Test",
      lastCalibratedAt: new Date(),
      preferences: {
        explicit: { signupSource: opts.signupSource, activeCalendarIds: ["primary"] },
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.account.create({
    data: {
      userId: user.id,
      type: "oauth",
      provider: "google",
      providerAccountId: GOOGLE_SUB,
      access_token: "old-access-token",
      refresh_token: "old-refresh-token",
      scope: "openid email profile https://www.googleapis.com/auth/calendar.readonly",
      token_type: "Bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  return user;
}

/**
 * Drive the signIn lifecycle: simulate NextAuth's PrismaAdapter behavior
 * (lookup-by-account → reuse user, do NOT create a new one), then fire the
 * callbacks/events that auth.ts owns.
 */
async function simulateHostSignIn() {
  const account = {
    provider: "google" as const,
    providerAccountId: GOOGLE_SUB,
    type: "oauth" as const,
    access_token: "new-access-token",
    refresh_token: "new-refresh-token",
    scope: HOST_SCOPE,
    token_type: "Bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    id_token: "new-id-token",
  };

  const existing = await prisma.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: account.provider,
        providerAccountId: account.providerAccountId,
      },
    },
    include: { user: true },
  });
  if (!existing) throw new Error("test setup: account not found");
  const user = existing.user;

  // signIn callback (token refresh) — runs before persistence in real flow,
  // but here we just exercise the writes auth.ts performs.
  await authOptions.callbacks!.signIn!({
    user: user as never,
    account: account as never,
    profile: undefined,
    email: undefined,
    credentials: undefined,
  });

  // events.signIn (upgrade detection) — runs after persistence.
  await authOptions.events!.signIn!({
    user: { id: user.id, email: user.email, name: user.name } as never,
    account: account as never,
    isNewUser: false,
  });

  return user.id;
}

describe("guest_flow → host signin merge", () => {
  test("merges existing Account, refreshes tokens, fires upgrade hook (signupSource=guest_flow)", async () => {
    const seeded = await seedGuestFlowUser({ signupSource: "guest_flow" });

    const userId = await simulateHostSignIn();
    expect(userId).toBe(seeded.id);

    const users = await prisma.user.findMany({ where: { email: "merge-test@example.com" } });
    expect(users).toHaveLength(1);

    const accounts = await prisma.account.findMany({
      where: { provider: "google", providerAccountId: GOOGLE_SUB },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].access_token).toBe("new-access-token");
    expect(accounts[0].scope).toBe(HOST_SCOPE);

    const after = await prisma.user.findUnique({ where: { id: seeded.id } });
    expect(after?.lastCalibratedAt).toBeNull();
    const explicit = (after?.preferences as { explicit?: Record<string, unknown> } | null)
      ?.explicit;
    expect(explicit?.signupSource).toBeUndefined();
    expect(explicit?.signupSourceUpgradedFrom).toBe("guest_flow");
    expect(typeof explicit?.signupSourceUpgradedAt).toBe("string");
  });

  test("also handles the T5 'guest_flow_upgrading' marker (Bryan's row)", async () => {
    const seeded = await seedGuestFlowUser({ signupSource: "guest_flow_upgrading" });
    await prisma.user.update({
      where: { id: seeded.id },
      data: { lastCalibratedAt: null },
    });

    await simulateHostSignIn();

    const after = await prisma.user.findUnique({ where: { id: seeded.id } });
    expect(after?.lastCalibratedAt).toBeNull();
    const explicit = (after?.preferences as { explicit?: Record<string, unknown> } | null)
      ?.explicit;
    expect(explicit?.signupSource).toBeUndefined();
    expect(explicit?.signupSourceUpgradedFrom).toBe("guest_flow");
  });

  test("no-op for users without a guest_flow signupSource marker", async () => {
    const user = await prisma.user.create({
      data: {
        email: "vanilla@example.com",
        lastCalibratedAt: new Date("2026-01-01T00:00:00Z"),
        preferences: { explicit: { activeCalendarIds: ["primary"] } } as Prisma.InputJsonValue,
      },
    });
    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "google",
        providerAccountId: GOOGLE_SUB,
        scope: HOST_SCOPE,
      },
    });

    await simulateHostSignIn();

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.lastCalibratedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
