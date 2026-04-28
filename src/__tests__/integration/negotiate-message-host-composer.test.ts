/**
 * Negotiate-message route — host-vs-guest composer selection (PR3 of the
 * 2026-04-27 chat-decisioning-layer-redesign).
 *
 * Three scenarios cover the load-bearing PR3 invariants on
 * `/api/negotiate/message`:
 *
 *  T1. Host posts a directive ("book it for friday at 2pm") →
 *      `dealroom-host-composer.md` content is loaded into the system
 *      prompt (assert by signature substring), and the conversation
 *      history is forwarded WITHOUT a `[HOST]:` prefix (proposal §2.6
 *      drop of prefix-sniffing).
 *
 *  T2. Host asks a status question ("what's the status?") → still loads
 *      the host composer (selection is by `isHost`, not content). The
 *      composer's "Status Questions" section instructs the model to
 *      answer without action emission; we assert composer presence here
 *      and leave action-emission negative-assertion to bench/QA.
 *
 *  T3. Guest posts a proposal ("how about wednesday morning?") →
 *      `dealroom-guest-composer.md` content is loaded; the host
 *      composer's audience-model header is NOT present in the prompt.
 *
 * The full streaming response, action parsing, and DB writes are
 * exercised in production paths and by manual QA / bench. Here we mock
 * the LLM (`streamAgentResponse`) to capture the composed system prompt
 * + role flag and isolate the composer-selection seam being changed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetDb } from "./helpers/db";
import { createUser } from "./helpers/fixtures";

// ---------------------------------------------------------------------------
// Module mocks. Order matters — vi.mock hoists, but the route imports below
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

// Capture every call to streamAgentResponse so we can assert composer
// selection (via the composed system prompt) and history shape (no `[HOST]:`
// prefix). The mock returns a minimal stream-shaped object that the route
// will toTextStreamResponse(). We intentionally do NOT exercise onFinish —
// action parsing and DB writes are tested elsewhere.
const streamAgentResponseMock = vi.fn();
vi.mock("@/agent/agent-runner", async () => {
  const actual = await vi.importActual<typeof import("@/agent/agent-runner")>(
    "@/agent/agent-runner",
  );
  return {
    ...actual,
    streamAgentResponse: (...args: unknown[]) => streamAgentResponseMock(...args),
  };
});

// Calendar / scoring — unused on the paths we hit, but stub defensively so
// a passing test isn't dependent on Google Calendar credentials in CI.
vi.mock("@/lib/calendar", async () => {
  const actual = await vi.importActual<typeof import("@/lib/calendar")>(
    "@/lib/calendar",
  );
  return {
    ...actual,
    getOrComputeSchedule: vi.fn(async () => ({
      connected: false,
      events: [],
      calendars: [],
      timezone: "America/Los_Angeles",
      canWrite: false,
      slots: [],
    })),
  };
});

import { POST } from "@/app/api/negotiate/message/route";
import { getServerSession } from "next-auth";
import { prisma } from "./helpers/db";
import { composeSystemPrompt } from "@/agent/composer";
import type { AgentContext } from "@/agent/agent-runner";

// Signature substrings used to detect which composer was loaded. These
// strings are unique to one composer file at the time of writing — if a
// future content edit removes them, this test will fail loudly and the
// signature should be re-chosen, not the assertion weakened.
const HOST_COMPOSER_SIGNATURE = "# Deal-Room Host Composer";
const GUEST_COMPOSER_SIGNATURE = "# Calendar Coordination — Domain Playbook";

const ORIGIN = "http://localhost:3000";

beforeEach(async () => {
  await resetDb();
  streamAgentResponseMock.mockReset();
  // Default: return a stream-shaped object that the route can pipe back.
  // toTextStreamResponse() is provided by the AI SDK; we mimic the minimal
  // shape the route actually consumes.
  streamAgentResponseMock.mockImplementation(async () => ({
    toTextStreamResponse: () =>
      new Response(new ReadableStream({
        start(controller) { controller.close(); },
      })),
  }));
  process.env.NEXTAUTH_URL = ORIGIN;
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeRequest(body: { sessionId: string; content: string; guestEmail?: string }): Request {
  return new Request("http://localhost:3000/api/negotiate/message", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

/**
 * Build a deal-room session. Returns the session id and host id so the
 * test can flip auth between "session is host" and "session is guest".
 */
async function seedSession(): Promise<{ sessionId: string; hostId: string; hostEmail: string }> {
  const host = await createUser({ email: "host@dealroom.test", name: "Host User" });
  const link = await prisma.negotiationLink.create({
    data: {
      userId: host.id,
      slug: `dealroom-${Math.random().toString(36).slice(2, 8)}`,
      type: "primary",
      mode: "single",
      rules: {},
    },
  });
  const session = await prisma.negotiationSession.create({
    data: {
      linkId: link.id,
      hostId: host.id,
      status: "active",
      type: "calendar",
      duration: 30,
      meetingType: "video",
    },
  });
  return { sessionId: session.id, hostId: host.id, hostEmail: host.email! };
}

/**
 * Compose the same system prompt the route would compose for the captured
 * AgentContext, so the test can assert composer-content presence. The
 * route calls streamAgentResponse(context); inside that function the
 * composer runs. We re-run the composer here on the captured context to
 * inspect the result.
 */
function composeFromCapturedContext(ctx: AgentContext): string {
  return composeSystemPrompt({
    domain: "calendar",
    sessionId: ctx.sessionId,
    hostName: ctx.hostName,
    hostPreferences: ctx.hostPreferences,
    guestName: ctx.guestName,
    guestEmail: ctx.guestEmail,
    guestTimezone: ctx.guestTimezone,
    viewerTimezone: ctx.viewerTimezone,
    guestMessage: ctx.guestMessage,
    topic: ctx.topic,
    rules: ctx.rules,
    calendarContext: ctx.calendarContext,
    scoredSlots: ctx.scoredSlots,
    hostPersistentKnowledge: ctx.hostPersistentKnowledge,
    hostUpcomingSchedulePreferences: ctx.hostUpcomingSchedulePreferences,
    hostDirectives: ctx.hostDirectives,
    isGroupEvent: ctx.isGroupEvent,
    eventParticipants: ctx.eventParticipants,
    role: ctx.role,
    isHost: ctx.isHost,
    negotiatedActivity: ctx.negotiatedActivity,
    negotiatedLocation: ctx.negotiatedLocation,
    negotiatedFormat: ctx.negotiatedFormat,
    activityOptions: ctx.activityOptions,
  });
}

describe("/api/negotiate/message — composer selection (PR3 invariants)", () => {
  test("T1: host directive routes through dealroom-host-composer (no [HOST]: prefix in history)", async () => {
    const { sessionId, hostEmail } = await seedSession();
    // Auth as the host.
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: (await prisma.user.findUniqueOrThrow({ where: { email: hostEmail } })).id, email: hostEmail },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    const res = await POST(
      makeRequest({ sessionId, content: "book it for friday at 2pm" }) as unknown as Parameters<
        typeof POST
      >[0],
    );
    // Drain the stream so the route's onFinish (if any) runs to completion.
    if (res.body) {
      const reader = res.body.getReader();
      while (!(await reader.read()).done) { /* drain */ }
    }

    expect(streamAgentResponseMock).toHaveBeenCalledTimes(1);
    const [capturedContext] = streamAgentResponseMock.mock.calls[0] as [AgentContext, unknown];

    // Invariant 1a: isHost flag is true when auth user matches session.hostId.
    expect(capturedContext.isHost).toBe(true);

    // Invariant 1b: history forwarded WITHOUT the legacy [HOST]: prefix.
    // PR3 drops prefix-sniffing — audience is selected by composer, not text.
    const lastTurn = capturedContext.conversationHistory.at(-1);
    expect(lastTurn?.content).toBe("book it for friday at 2pm");
    expect(lastTurn?.content.startsWith("[HOST]:")).toBe(false);

    // Invariant 1c: the host composer is the loaded playbook.
    const systemPrompt = composeFromCapturedContext(capturedContext);
    expect(systemPrompt).toContain(HOST_COMPOSER_SIGNATURE);
    expect(systemPrompt).not.toContain(GUEST_COMPOSER_SIGNATURE);
  });

  test("T2: host status question still routes through dealroom-host-composer", async () => {
    const { sessionId, hostEmail } = await seedSession();
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: (await prisma.user.findUniqueOrThrow({ where: { email: hostEmail } })).id, email: hostEmail },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    const res = await POST(
      makeRequest({ sessionId, content: "what's the status?" }) as unknown as Parameters<
        typeof POST
      >[0],
    );
    if (res.body) {
      const reader = res.body.getReader();
      while (!(await reader.read()).done) { /* drain */ }
    }

    expect(streamAgentResponseMock).toHaveBeenCalledTimes(1);
    const [capturedContext] = streamAgentResponseMock.mock.calls[0] as [AgentContext, unknown];
    expect(capturedContext.isHost).toBe(true);

    // The host composer's "Status Questions" section is what shapes the
    // reply (no action emission for inquiries). We assert the composer is
    // present here; the no-action-emission behavior is exercised by the
    // bench against the mocked LLM in production.
    const systemPrompt = composeFromCapturedContext(capturedContext);
    expect(systemPrompt).toContain(HOST_COMPOSER_SIGNATURE);
    expect(systemPrompt).toContain("## Status Questions");
  });

  test("T3: guest proposal routes through dealroom-guest-composer", async () => {
    const { sessionId } = await seedSession();
    // Auth as a different user — NOT the host. The route's `isHost`
    // check (`session.user.id === session.hostId`) returns false, so the
    // guest composer fires.
    const guest = await createUser({ email: "guest@dealroom.test", name: "Guest User" });
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: guest.id, email: guest.email },
    } as unknown as Awaited<ReturnType<typeof getServerSession>>);

    const res = await POST(
      makeRequest({
        sessionId,
        content: "how about wednesday morning?",
        guestEmail: "guest@dealroom.test",
      }) as unknown as Parameters<typeof POST>[0],
    );
    if (res.body) {
      const reader = res.body.getReader();
      while (!(await reader.read()).done) { /* drain */ }
    }

    expect(streamAgentResponseMock).toHaveBeenCalledTimes(1);
    const [capturedContext] = streamAgentResponseMock.mock.calls[0] as [AgentContext, unknown];

    expect(capturedContext.isHost).toBe(false);
    const lastTurn = capturedContext.conversationHistory.at(-1);
    expect(lastTurn?.content).toBe("how about wednesday morning?");
    expect(lastTurn?.content.startsWith("[HOST]:")).toBe(false);

    const systemPrompt = composeFromCapturedContext(capturedContext);
    expect(systemPrompt).toContain(GUEST_COMPOSER_SIGNATURE);
    expect(systemPrompt).not.toContain(HOST_COMPOSER_SIGNATURE);
  });
});
