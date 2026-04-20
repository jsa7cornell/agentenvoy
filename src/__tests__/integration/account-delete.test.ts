/**
 * Account deletion — real-DB FK cascade test.
 *
 * Seeds a user with rows across every table that references User (directly
 * or transitively), plus rows where the user appears as guest / participant
 * on ANOTHER user's link. Calls the route handler directly with a mocked
 * NextAuth session. Asserts the graph is gone, and that the other user's
 * rows survive with null FKs where appropriate.
 *
 * This is the test that would catch a missing `onDelete` declaration on a
 * future schema change. If a new User-referencing table is added to
 * schema.prisma, extend the seed in this test.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "./helpers/db";
import { resetDb } from "./helpers/db";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

// Route reads `prisma` from "@/lib/prisma" — alias it to the integration
// helper's singleton so the handler's writes go to the same DB this test
// reads from.
vi.mock("@/lib/prisma", async () => {
  const { prisma } = await import("./helpers/db");
  return { prisma };
});

import { POST } from "@/app/api/account/delete/route";
import { getServerSession } from "next-auth";

const ORIGIN = "http://localhost:3000";

beforeEach(async () => {
  await resetDb();
  process.env.NEXTAUTH_URL = "http://localhost:3000";
  // Stub Google revoke so the test doesn't hit the network.
  vi.spyOn(global, "fetch").mockResolvedValue(new Response("", { status: 200 }));
});

function makeRequest(confirmEmail: string): Request {
  return new Request("http://localhost:3000/api/account/delete", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ confirmEmail }),
  });
}

describe("account deletion — end-to-end cascade", () => {
  test("wipes the full owned graph, preserves other users' rows with nulled FKs", async () => {
    // ── Seed: the user being deleted ─────────────────────────────
    const target = await prisma.user.create({
      data: {
        email: "target@delete.test",
        name: "Target User",
        meetSlug: "target-slug",
        preferences: { explicit: { timezone: "America/Los_Angeles" } },
      },
    });

    await prisma.account.create({
      data: {
        userId: target.id,
        type: "oauth",
        provider: "google",
        providerAccountId: "google-target",
        refresh_token: "rt_target",
        access_token: "at_target",
      },
    });

    await prisma.session.create({
      data: {
        userId: target.id,
        sessionToken: "session-target-1",
        expires: new Date(Date.now() + 86_400_000),
      },
    });

    await prisma.apiKey.create({
      data: { userId: target.id, key: "hashed-target-key", name: "Default" },
    });

    await prisma.channel.create({
      data: {
        userId: target.id,
        messages: {
          create: [{ role: "user", content: "hi" }],
        },
      },
    });

    await prisma.calendarCache.create({
      data: {
        userId: target.id,
        calendarId: "primary",
        calendarName: "Primary",
        events: [],
      },
    });

    await prisma.computedSchedule.create({
      data: { userId: target.id, slots: [], inputHash: "x" },
    });

    // Target owns a link with a session, messages, proposals, outcome, hold,
    // participants, consent request, and MCP logs.
    const link = await prisma.negotiationLink.create({
      data: { userId: target.id, slug: "target-slug", type: "generic", mode: "single" },
    });

    const hostedSession = await prisma.negotiationSession.create({
      data: {
        linkId: link.id,
        hostId: target.id,
        status: "active",
        duration: 30,
        meetingType: "video",
        messages: { create: [{ role: "administrator", content: "hello" }] },
      },
    });

    await prisma.proposal.create({
      data: { sessionId: hostedSession.id, duration: 30 },
    });

    await prisma.negotiationOutcome.create({
      data: { sessionId: hostedSession.id, exchangeCount: 2, tierReached: 1 },
    });

    await prisma.hold.create({
      data: {
        sessionId: hostedSession.id,
        hostId: target.id,
        slotStart: new Date(),
        slotEnd: new Date(Date.now() + 1800_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await prisma.sessionParticipant.create({
      data: { linkId: link.id, sessionId: hostedSession.id, email: "guest@a.test", role: "guest" },
    });

    await prisma.consentRequest.create({
      data: {
        linkId: link.id,
        field: "format",
        appliedValue: { format: "video" },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    await prisma.mCPCallLog.create({
      data: {
        linkId: link.id,
        tool: "get_session_status",
        requestBody: {},
        responseBody: {},
        outcome: "ok",
      },
    });

    // SideEffectLog row tagged to this user (contextJson.userId).
    await prisma.sideEffectLog.create({
      data: {
        kind: "email.send",
        mode: "live",
        status: "sent",
        targetSummary: "target@delete.test",
        payload: {},
        contextJson: { userId: target.id, purpose: "welcome" },
      },
    });

    // RouteError row for this user.
    await prisma.routeError.create({
      data: {
        route: "/api/foo",
        message: "boom",
        userId: target.id,
      },
    });

    // ── Seed: a second user (survives deletion) ──────────────────
    const survivor = await prisma.user.create({
      data: { email: "survivor@test.test", name: "Survivor" },
    });
    const survivorLink = await prisma.negotiationLink.create({
      data: { userId: survivor.id, slug: "survivor-slug", type: "generic", mode: "single" },
    });
    // Target appears as *guest* on survivor's session — must survive with guestId = null.
    const crossSession = await prisma.negotiationSession.create({
      data: {
        linkId: survivorLink.id,
        hostId: survivor.id,
        guestId: target.id,
        status: "active",
        duration: 30,
        meetingType: "video",
      },
    });
    // Target as a participant on survivor's link.
    const crossParticipant = await prisma.sessionParticipant.create({
      data: {
        linkId: survivorLink.id,
        sessionId: crossSession.id,
        userId: target.id,
        email: "target@delete.test",
        role: "guest",
      },
    });

    // SideEffectLog row for ANOTHER user — must NOT be deleted.
    const survivorLog = await prisma.sideEffectLog.create({
      data: {
        kind: "email.send",
        mode: "live",
        status: "sent",
        targetSummary: "survivor@test.test",
        payload: {},
        contextJson: { userId: survivor.id, purpose: "welcome" },
      },
    });

    // ── Call the handler ─────────────────────────────────────────
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: target.id, email: target.email },
    });
    const res = await POST(makeRequest(target.email!) as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // ── Assert: target graph wiped ───────────────────────────────
    expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await prisma.account.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.apiKey.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.channel.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.calendarCache.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.computedSchedule.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.negotiationLink.count({ where: { id: link.id } })).toBe(0);
    expect(await prisma.negotiationSession.count({ where: { id: hostedSession.id } })).toBe(0);
    expect(await prisma.proposal.count({ where: { sessionId: hostedSession.id } })).toBe(0);
    expect(await prisma.negotiationOutcome.count({ where: { sessionId: hostedSession.id } })).toBe(0);
    expect(await prisma.hold.count({ where: { sessionId: hostedSession.id } })).toBe(0);
    expect(await prisma.consentRequest.count({ where: { linkId: link.id } })).toBe(0);
    expect(await prisma.mCPCallLog.count({ where: { linkId: link.id } })).toBe(0);
    expect(await prisma.routeError.count({ where: { userId: target.id } })).toBe(0);
    // SideEffectLog rows tagged to the deleted user are gone.
    const targetLogs = await prisma.sideEffectLog.findMany({
      where: { contextJson: { path: ["userId"], equals: target.id } },
    });
    expect(targetLogs).toHaveLength(0);

    // ── Assert: survivor untouched; cross-refs nulled ────────────
    expect(await prisma.user.findUnique({ where: { id: survivor.id } })).not.toBeNull();
    expect(await prisma.negotiationLink.count({ where: { id: survivorLink.id } })).toBe(1);
    const refreshedCross = await prisma.negotiationSession.findUnique({
      where: { id: crossSession.id },
    });
    expect(refreshedCross).not.toBeNull();
    expect(refreshedCross!.guestId).toBeNull();
    const refreshedParticipant = await prisma.sessionParticipant.findUnique({
      where: { id: crossParticipant.id },
    });
    expect(refreshedParticipant).not.toBeNull();
    expect(refreshedParticipant!.userId).toBeNull();
    expect(await prisma.sideEffectLog.count({ where: { id: survivorLog.id } })).toBe(1);
  });
});
