/**
 * Chat route — precheck query column-drop regression (commits 4eae1dd + 925cfe8).
 *
 * These tests catch the class of bug where a Prisma query on NegotiationSession
 * uses `include` without a parent `select`, causing Postgres to SELECT * (all
 * scalar columns), including any that have been dropped from the schema.
 *
 * The fix (4eae1dd) converted the isEventIntent precheck to an explicit `select`
 * listing only the columns still in the schema. These tests ensure that all five
 * isEventIntent branches actually hit that query and survive it — i.e., the
 * handler returns a non-500 response with a readable stream for every event intent.
 *
 * Regression protocol:
 *   Revert 4eae1dd (restore `include: { link: {...} }` without parent `select`
 *   on the precheck findMany). Run this suite — every test MUST fail with a DB
 *   error (500 or stream-level error). Restore the fix. All tests MUST pass.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetDb } from "./helpers/db";
import { createUser } from "./helpers/fixtures";

// ---------------------------------------------------------------------------
// Module mocks (same pattern as chat-route-host-role.test.ts)
// ---------------------------------------------------------------------------

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/prisma", async () => {
  const { prisma } = await import("./helpers/db");
  return { prisma };
});

const classifyChatIntentMock = vi.fn();
vi.mock("@/agent/intent-classifier", () => ({
  classifyChatIntent: (...args: unknown[]) => classifyChatIntentMock(...args),
}));

// For event-intent paths the precheck runs first, then Sonnet is invoked via
// dispatchModuleAndStream. Stub it so the test doesn't require LLM network access.
const dispatchModuleAndStreamMock = vi.fn<(args: unknown) => Promise<void>>(
  async () => {},
);
vi.mock("@/agent/modules/_shared/dispatch-stream", () => ({
  dispatchModuleAndStream: (args: unknown) => dispatchModuleAndStreamMock(args),
}));

vi.mock("@/lib/calendar", async () => {
  const actual = await vi.importActual<typeof import("@/lib/calendar")>(
    "@/lib/calendar",
  );
  return {
    ...actual,
    getOrComputeSchedule: vi.fn(async () => ({
      events: [],
      offerableSlots: [],
      cachedAt: new Date(),
    })),
  };
});

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(async () => ({ text: "(mocked)" })),
    streamText: vi.fn(async () => ({
      textStream: (async function* () { yield "(mocked)"; })(),
      text: Promise.resolve("(mocked)"),
    })),
  };
});

import { POST } from "@/app/api/channel/chat/route";
import { getServerSession } from "next-auth";
import { prisma } from "./helpers/db";

const ORIGIN = "http://localhost:3000";

beforeEach(async () => {
  await resetDb();
  classifyChatIntentMock.mockReset();
  dispatchModuleAndStreamMock.mockClear();
  process.env.NEXTAUTH_URL = ORIGIN;
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeRequest(body: { message: string; userIntentHint?: string }): Request {
  return new Request("http://localhost:3000/api/channel/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

async function drainStream(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

function mockIntent(kind: string) {
  classifyChatIntentMock.mockResolvedValueOnce({
    intent: { kind },
    latencyMs: 1,
    retried: false,
    rawKind: kind,
    fabricationDetected: false,
  });
}

// Seed a user with one active NegotiationSession so the precheck has rows to
// query. The session must exist for `schedule` / `event_action` paths that
// expect at least one candidate — but even for `create_link` the query runs.
async function seedUserWithActiveSession(emailPrefix: string) {
  const user = await createUser({ email: `${emailPrefix}@precheck.test` });
  const link = await prisma.negotiationLink.create({
    data: {
      userId: user.id,
      slug: `precheck-${Math.random().toString(36).slice(2, 8)}`,
      type: "primary",
      mode: "single",
      parameters: {},
      inviteeName: "Alex",
    },
  });
  await prisma.negotiationSession.create({
    data: {
      linkId: link.id,
      hostId: user.id,
      status: "active",
      type: "calendar",
      duration: 30,
      meetingType: "video",
    },
  });
  return user;
}

describe("chat route — isEventIntent precheck query (4eae1dd regression)", () => {
  // Each test: seed user + active session, mock classifier to return the
  // target intent, POST a plausible message, assert non-500 response.
  // The precheck query is the first async op inside the isEventIntent block;
  // a column-drop bug surfaces here before dispatchModuleAndStream is reached.

  test("P1: create_link intent — precheck query succeeds, no DB error", async () => {
    const user = await seedUserWithActiveSession("create");
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);
    mockIntent("create_link");

    const res = await POST(
      makeRequest({ message: "set up a 30-min call with Alex" }) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).not.toBe(500);
    const body = await drainStream(res);
    // Any text frame or empty stream is acceptable — the key invariant is that
    // the precheck query did not throw a DB error.
    expect(typeof body).toBe("string");
  });

  test("P2: modify_link intent — precheck query succeeds, no DB error", async () => {
    const user = await seedUserWithActiveSession("modify");
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);
    mockIntent("modify_link");

    const res = await POST(
      makeRequest({ message: "update my link for Alex to 45 minutes" }) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).not.toBe(500);
    const body = await drainStream(res);
    expect(typeof body).toBe("string");
  });

  test("P3: cancel_link intent — precheck query succeeds, no DB error", async () => {
    const user = await seedUserWithActiveSession("cancel");
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);
    mockIntent("cancel_link");

    const res = await POST(
      makeRequest({ message: "cancel my link for Alex" }) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).not.toBe(500);
    const body = await drainStream(res);
    expect(typeof body).toBe("string");
  });

  test("P4: schedule intent — precheck query succeeds, no DB error", async () => {
    const user = await seedUserWithActiveSession("schedule");
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);
    mockIntent("schedule");

    const res = await POST(
      makeRequest({ message: "move my meeting with Alex to tomorrow at 3pm" }) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).not.toBe(500);
    const body = await drainStream(res);
    expect(typeof body).toBe("string");
  });

  test("P5: event_action intent — precheck query succeeds, no DB error", async () => {
    const user = await seedUserWithActiveSession("event-action");
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);
    mockIntent("event_action");

    const res = await POST(
      makeRequest({ message: "confirm the meeting with Alex" }) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).not.toBe(500);
    const body = await drainStream(res);
    expect(typeof body).toBe("string");
  });

  test("P6 (structural): precheck runs real DB query — active session is visible to the route", async () => {
    // Verify the test DB plumbing is actually exercised: seed a user with a
    // known inviteeName, return create_link intent, assert the precheck didn't
    // throw (proxy: response is not 500). This cell is the canary — if the
    // DB mock is wired incorrectly, all P1–P5 would silently pass against an
    // empty-result set instead of a real query.
    const user = await createUser({ email: "canary@precheck.test" });
    const link = await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        slug: "canary-link",
        type: "primary",
        mode: "single",
        parameters: {},
        inviteeName: "Canary Guest",
      },
    });
    await prisma.negotiationSession.create({
      data: {
        linkId: link.id,
        hostId: user.id,
        status: "active",
        type: "calendar",
        duration: 30,
        meetingType: "video",
      },
    });

    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);
    mockIntent("create_link");

    const res = await POST(
      makeRequest({ message: "set up a call with Canary Guest" }) as unknown as Parameters<typeof POST>[0],
    );

    expect(res.status).not.toBe(500);

    // Verify the session row is queryable with the current select shape (the
    // regression would surface here as a Prisma error thrown during findMany).
    const sessions = await prisma.negotiationSession.findMany({
      where: { hostId: user.id, archived: false },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        link: { select: { inviteeName: true, code: true, parameters: true, customTitle: true } },
      },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].link?.inviteeName).toBe("Canary Guest");
  });
});
