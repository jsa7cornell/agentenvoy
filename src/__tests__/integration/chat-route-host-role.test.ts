/**
 * Chat route — host-role plumbing + marcoPending replay (chat-decisioning-
 * layer-redesign PR1, §10 prod-bug catalog).
 *
 * Focused integration tests for the three load-bearing PR1 invariants on
 * the route handler:
 *
 *  T1. `classifyChatIntent` is called with `role: "host"` for every host
 *      utterance (Bugs #1/#2/#3 root cause).
 *  T2. `marcoPending` replay collapses a `linkCode`-referencing host reply
 *      to a deterministic action and clears the flag single-shot (Bug #5).
 *  T3. The `chat` intent skips the scheduling precheck entirely (Bug #2 —
 *      "change to light mode" must NOT route into create/modify/cancel).
 *
 * The full streaming response (status frames, narration, [ACTION] blocks)
 * is exercised end-to-end by manual QA + the bench. Here we mock the LLM
 * and calendar layers so the test runs without network access and isolates
 * the routing/classification seam being changed in PR1.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetDb } from "./helpers/db";
import { createUser } from "./helpers/fixtures";

// ---------------------------------------------------------------------------
// Module mocks. Order matters — vi.mock hoists, but the imports below
// must come AFTER the mocks so the route picks up our test doubles.
// ---------------------------------------------------------------------------

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

// Route reads `prisma` from "@/lib/prisma" — alias to the integration helper
// so writes from the handler land in the same DB this test reads from.
vi.mock("@/lib/prisma", async () => {
  const { prisma } = await import("./helpers/db");
  return { prisma };
});

// Capture every call to the classifier so we can assert role plumbing.
const classifyChatIntentMock = vi.fn();
vi.mock("@/agent/intent-classifier", () => ({
  classifyChatIntent: (...args: unknown[]) => classifyChatIntentMock(...args),
}));

// dispatch-handler is invoked for edit_preference / profile / rule. Stub it
// out so the test doesn't need the full LLM streaming pipeline; we just
// assert it's called with the right tier.
const runDispatchHandlerMock = vi.fn<(args: unknown) => Promise<void>>(
  async () => {
    // Simulate the handler closing the stream cleanly.
  },
);
vi.mock("@/agent/dispatch-handler", () => ({
  runDispatchHandler: (args: unknown) => runDispatchHandlerMock(args),
}));

// Calendar — the route loads it for `schedule` / inquire tiers. Under the
// host paths we exercise (chat / marco-replay / edit_preference) it isn't
// reached, but we stub it defensively.
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

// `ai` SDK — keep the schema-driven generateObject path intact for
// classifyChatIntent's mock to drive, but stub generateText so the
// composer doesn't try to call the gateway when we accidentally fall
// through.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(async () => ({ text: "(mocked)" })),
  };
});

import { POST } from "@/app/api/channel/chat/route";
import { getServerSession } from "next-auth";
import { prisma } from "./helpers/db";

const ORIGIN = "http://localhost:3000";

beforeEach(async () => {
  await resetDb();
  classifyChatIntentMock.mockReset();
  runDispatchHandlerMock.mockClear();
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

describe("chat route — host-role plumbing (PR1 invariants)", () => {
  test("T1: classifyChatIntent is called with role='host' for a host utterance", async () => {
    const user = await createUser({ email: "host@chat.test" });
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    classifyChatIntentMock.mockResolvedValueOnce({
      intent: { kind: "chat" },
      latencyMs: 1,
      retried: false,
      rawKind: "chat",
      fabricationDetected: false,
    });

    const res = await POST(
      makeRequest({ message: "hey there!" }) as unknown as Parameters<
        typeof POST
      >[0],
    );
    await drainStream(res);

    expect(classifyChatIntentMock).toHaveBeenCalledTimes(1);
    const args = classifyChatIntentMock.mock.calls[0];
    // Signature: (message, ctx, role)
    expect(args[0]).toBe("hey there!");
    expect(args[2]).toBe("host");
  });

  test("T2: marcoPending replay resolves a linkCode mention and clears the flag (single-shot)", async () => {
    const user = await createUser({ email: "marco@chat.test" });
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    // Seed a channel + an envoy turn carrying marcoPending metadata.
    const channel = await prisma.channel.create({ data: { userId: user.id } });
    const envoyTurn = await prisma.channelMessage.create({
      data: {
        channelId: channel.id,
        role: "envoy",
        content: "Two Jon links — abc123 (1:1) or xyz789 (bike). Which one?",
        metadata: {
          marcoPending: {
            matchedLinkIds: ["abc123", "xyz789"],
            originatingIntent: "modify_link",
          },
        },
      },
    });

    // The host references one of the matched link codes — the replay path
    // should resolve to {kind: "modify_link", linkCode: "abc123"} and the
    // classifier must NOT be called.
    const res = await POST(
      makeRequest({ message: "the abc123 one please" }) as unknown as Parameters<
        typeof POST
      >[0],
    );
    await drainStream(res);

    // Replay short-circuits the classifier.
    expect(classifyChatIntentMock).not.toHaveBeenCalled();

    // marcoPending flag is cleared on the prior envoy turn.
    const updated = await prisma.channelMessage.findUniqueOrThrow({
      where: { id: envoyTurn.id },
    });
    const meta = updated.metadata as Record<string, unknown> | null;
    expect(meta?.marcoPending).toBeNull();
  });

  test("T3: chat intent skips precheck and routes to free-form composer (Bug #2 invariant)", async () => {
    const user = await createUser({ email: "chat@chat.test" });
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    // Even with an active session for the user (which would normally be
    // candidate fodder for the precheck), a `chat` classification must not
    // route into create/modify/cancel.
    const link = await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        slug: `chat-${Math.random().toString(36).slice(2, 8)}`,
        type: "primary",
        mode: "single",
        rules: {},
        inviteeName: "Katie",
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

    classifyChatIntentMock.mockResolvedValueOnce({
      intent: { kind: "chat" },
      latencyMs: 1,
      retried: false,
      rawKind: "chat",
      fabricationDetected: false,
    });

    const res = await POST(
      makeRequest({ message: "change to light mode" }) as unknown as Parameters<
        typeof POST
      >[0],
    );
    await drainStream(res);

    // Classifier called exactly once with role:host.
    expect(classifyChatIntentMock).toHaveBeenCalledTimes(1);
    expect(classifyChatIntentMock.mock.calls[0][2]).toBe("host");

    // Dispatch-handler must NOT be called for `chat` (only for
    // edit_preference / profile / rule). If it had fired, it would mean
    // the chat tier was being routed through the profile playbook, which
    // is the wrong shape for a free-form host turn.
    expect(runDispatchHandlerMock).not.toHaveBeenCalled();
  });

  test("T4 (bonus): edit_preference routes through dispatch-handler with profile tier", async () => {
    const user = await createUser({ email: "pref@chat.test" });
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    classifyChatIntentMock.mockResolvedValueOnce({
      intent: { kind: "edit_preference" },
      latencyMs: 1,
      retried: false,
      rawKind: "edit_preference",
      fabricationDetected: false,
    });

    const res = await POST(
      makeRequest({ message: "make my default 30 min" }) as unknown as Parameters<
        typeof POST
      >[0],
    );
    await drainStream(res);

    expect(runDispatchHandlerMock).toHaveBeenCalledTimes(1);
    const firstCall = runDispatchHandlerMock.mock.calls[0] as unknown as [
      { tier: string; playbookRelativePath: string },
    ];
    const dispatchArgs = firstCall[0];
    // PR1 keyword-heuristic stopgap: profile-shaped utterances ("make my
    // default 30 min" — no buffer/hours/days/am/pm/window/availability
    // tokens) route through profile.md. PR4 will split edit_preference at
    // the classifier level and remove this heuristic.
    expect(dispatchArgs.tier).toBe("profile");
    expect(dispatchArgs.playbookRelativePath).toBe(
      "src/agent/playbooks/profile.md",
    );
  });

  test("T4b: edit_preference with rule-shape keyword routes through rule tier", async () => {
    const user = await createUser({ email: "pref-rule@chat.test" });
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: user.email, name: user.name },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    classifyChatIntentMock.mockResolvedValueOnce({
      intent: { kind: "edit_preference" },
      latencyMs: 1,
      retried: false,
      rawKind: "edit_preference",
      fabricationDetected: false,
    });

    const res = await POST(
      makeRequest({
        message: "set my buffer to 15 minutes between meetings",
      }) as unknown as Parameters<typeof POST>[0],
    );
    await drainStream(res);

    expect(runDispatchHandlerMock).toHaveBeenCalledTimes(1);
    const firstCall = runDispatchHandlerMock.mock.calls[0] as unknown as [
      { tier: string; playbookRelativePath: string },
    ];
    const dispatchArgs = firstCall[0];
    // "buffer" + "minutes" — heuristic catches "buffer" and routes to
    // rule.md so the dispatch-handler loads availability-rule grammar.
    expect(dispatchArgs.tier).toBe("rule");
    expect(dispatchArgs.playbookRelativePath).toBe(
      "src/agent/playbooks/rule.md",
    );
  });
});
