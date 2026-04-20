/**
 * MCP HTTP route — in-process smoke test.
 *
 * Imports POST from `src/app/api/mcp/route.ts`, hand-builds a JSON-RPC
 * `tools/call` request for `get_meeting_parameters`, and asserts the
 * response carries the expected structuredContent. Authorization and
 * Prisma are mocked at module boundary so this is a pure wiring test —
 * end-to-end integration against real pg will land in the integration
 * suite once more tools are implemented.
 *
 * Two goals:
 *   1. Prove the MCP SDK + Streamable HTTP transport + tool registration
 *      are correctly wired (no "tool not found", no transport errors).
 *   2. Prove `get_meeting_parameters` returns a well-formed envelope for
 *      a happy-path link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Must mock BEFORE importing the route.
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>(
    "@/lib/mcp/auth"
  );
  return {
    ...actual,
    authorizeMcpCall: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    negotiationSession: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    message: {
      create: vi.fn(),
    },
    consentRequest: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

// propose_lock delegates to confirmBooking. Mock the pipeline so this
// remains a pure wiring test — confirm-pipeline has its own unit coverage.
vi.mock("@/lib/confirm-pipeline", () => ({
  confirmBooking: vi.fn(),
}));

// `get_availability` pulls the host's computed schedule. Mock the compute
// entry point so the test doesn't need a real user / Google OAuth token.
vi.mock("@/lib/calendar", () => ({
  getOrComputeSchedule: vi.fn(),
}));

import { authorizeMcpCall } from "@/lib/mcp/auth";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { POST } from "@/app/api/mcp/route";

const mockAuthorize = authorizeMcpCall as unknown as ReturnType<typeof vi.fn>;
const mockUserFind = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockSchedule = getOrComputeSchedule as unknown as ReturnType<typeof vi.fn>;

function jsonRpcCall(tool: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  };
}

/** Build a Request the Streamable-HTTP transport will accept. The key
 *  headers are Accept (MUST include both application/json AND text/event-stream)
 *  and Content-Type application/json. */
function makeRpcRequest(body: unknown): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function readJsonRpc(res: Response): Promise<{
  result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
  error?: { code: number; message: string };
}> {
  // enableJsonResponse: true → single JSON body per request.
  const text = await res.text();
  // If the server returned SSE despite enableJsonResponse:true, parse the
  // `data:` line. Otherwise JSON-parse the whole body.
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error(`SSE response had no data: line: ${text}`);
    return JSON.parse(dataLine.slice(5).trim());
  }
  return JSON.parse(text);
}

beforeEach(() => {
  mockAuthorize.mockReset();
  mockUserFind.mockReset();
  mockSchedule.mockReset();
});

describe("POST /api/mcp — initialize", () => {
  it("responds to initialize with server info", async () => {
    const req = makeRpcRequest({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const parsed = await readJsonRpc(res);
    expect(parsed.error).toBeUndefined();
    expect(parsed.result).toBeDefined();
  });
});

describe("POST /api/mcp — get_meeting_parameters happy path", () => {
  it("returns ok:true with a resolved envelope", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: {
        id: "link_1",
        userId: "user_1",
        rules: { format: "video", duration: 30 },
      },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockUserFind.mockResolvedValueOnce({
      preferences: { explicit: { timezone: "America/Los_Angeles" } },
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_meeting_parameters", { meetingUrl: "/meet/abc" })
      )
    );
    expect(res.status).toBe(200);

    const rpc = await readJsonRpc(res);
    expect(rpc.error).toBeUndefined();
    // Handler returns CallToolResult {content, structuredContent}
    const sc = rpc.result?.structuredContent;
    expect(sc?.ok).toBe(true);
    expect(sc?.meetingUrl).toBe("/meet/abc");
    const params = sc?.parameters as {
      format: { value: string; mutability: string };
      duration: { value: number };
      timezone: { value: string };
    };
    expect(params.format.value).toBe("video");
    expect(params.format.mutability).toBe("locked");
    expect(params.duration.value).toBe(30);
    expect(params.timezone.value).toBe("America/Los_Angeles");
  });
});

describe("POST /api/mcp — get_meeting_parameters auth refusal", () => {
  it("link_not_found → ok:false refusal", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: false,
      error: "link_not_found",
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_meeting_parameters", { meetingUrl: "/meet/nope" })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent;
    expect(sc?.ok).toBe(false);
    expect(sc?.reason).toBe("link_not_found");
  });

  it("rate_limit_exceeded → ok:false with retryAfterSeconds", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: false,
      error: "rate_limit_exceeded",
      retryAfterSeconds: 42,
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_meeting_parameters", { meetingUrl: "/meet/abc" })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent;
    expect(sc?.ok).toBe(false);
    expect(sc?.reason).toBe("rate_limited");
    expect(sc?.retryAfterSeconds).toBe(42);
  });
});

describe("POST /api/mcp — get_availability happy path", () => {
  it("returns scored slots with tier labels, filtering past/high-score", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const mk = (startMs: number, score: number) => ({
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + 30 * 60 * 1000).toISOString(),
      score,
      confidence: "high" as const,
      reason: "",
      kind: "open" as const,
      blockCost: "none" as const,
    });

    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: {
        id: "link_1",
        userId: "user_1",
        rules: {}, // vanilla link → score ≤ 1 only
        sourceRuleId: null,
      },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockUserFind.mockResolvedValueOnce({
      preferences: { explicit: { timezone: "America/Los_Angeles" } },
    });
    mockSchedule.mockResolvedValueOnce({
      connected: true,
      slots: [
        mk(future.getTime(), 0),            // offerable → first_offer
        mk(future.getTime() + 60 * 60_000, 3), // protected band on non-VIP → filtered
        mk(past.getTime(), 0),              // past → filtered
      ],
      events: [],
      timezone: "America/Los_Angeles",
      canWrite: true,
      calendars: [],
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_availability", { meetingUrl: "/meet/abc" })
      )
    );
    expect(res.status).toBe(200);
    const rpc = await readJsonRpc(res);
    expect(rpc.error).toBeUndefined();
    const sc = rpc.result?.structuredContent as {
      ok: boolean;
      timezone: string;
      slots: Array<{ start: string; score: number; tier?: string }>;
    };
    expect(sc.ok).toBe(true);
    expect(sc.timezone).toBe("America/Los_Angeles");
    expect(sc.slots.length).toBe(1);
    expect(sc.slots[0].score).toBe(0);
    expect(sc.slots[0].tier).toBe("first_offer");
  });

  it("not-connected host → ok:true with empty slot list", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_2", userId: "user_2", rules: {}, sourceRuleId: null },
      parsed: { slug: "xyz", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockUserFind.mockResolvedValueOnce({
      preferences: { explicit: { timezone: "UTC" } },
    });
    mockSchedule.mockResolvedValueOnce({
      connected: false,
      slots: [],
      events: [],
      timezone: "UTC",
      canWrite: false,
      calendars: [],
    });

    const res = await POST(
      makeRpcRequest(jsonRpcCall("get_availability", { meetingUrl: "/meet/xyz" }))
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as { ok: boolean; slots: unknown[] };
    expect(sc.ok).toBe(true);
    expect(sc.slots).toEqual([]);
  });
});

describe("POST /api/mcp — get_session_status", () => {
  const mockSessionFind = prisma.negotiationSession
    .findFirst as unknown as ReturnType<typeof vi.fn>;
  const mockConsentFind = prisma.consentRequest
    .findMany as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSessionFind.mockReset();
    mockConsentFind.mockReset().mockResolvedValue([]);
  });

  it("returns mapped status + agreedTime for an agreed session", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_1", userId: "u1", rules: {}, sourceRuleId: null },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    const agreedAt = new Date("2026-05-01T15:00:00Z");
    mockSessionFind.mockResolvedValueOnce({
      id: "sess_1",
      status: "agreed",
      agreedTime: agreedAt,
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_session_status", { meetingUrl: "/meet/abc" })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as {
      ok: boolean;
      status: string;
      sessionId: string;
      agreedTime: string | null;
      rescheduleHistory: unknown[];
      pendingConsentRequests: unknown[];
    };
    expect(sc.ok).toBe(true);
    expect(sc.status).toBe("agreed");
    expect(sc.sessionId).toBe("sess_1");
    expect(sc.agreedTime).toBe(agreedAt.toISOString());
    expect(sc.rescheduleHistory).toEqual([]);
  });

  it("maps internal 'escalated' → wire 'active'", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_1", userId: "u1", rules: {}, sourceRuleId: null },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockSessionFind.mockResolvedValueOnce({
      id: "sess_1",
      status: "escalated",
      agreedTime: null,
    });
    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_session_status", { meetingUrl: "/meet/abc" })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as { status: string };
    expect(sc.status).toBe("active");
  });

  it("no session on link → session_not_found refusal", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_1", userId: "u1", rules: {}, sourceRuleId: null },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockSessionFind.mockResolvedValueOnce(null);
    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_session_status", { meetingUrl: "/meet/abc" })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as { ok: boolean; reason: string };
    expect(sc.ok).toBe(false);
    expect(sc.reason).toBe("session_not_found");
  });

  it("surfaces pending consent requests with proposedValue", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_1", userId: "u1", rules: {}, sourceRuleId: null },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockSessionFind.mockResolvedValueOnce({
      id: "sess_1",
      status: "active",
      agreedTime: null,
    });
    const expiry = new Date(Date.now() + 60_000);
    mockConsentFind.mockResolvedValueOnce([
      {
        id: "consent_1",
        field: "format",
        appliedValue: "phone",
        expiresAt: expiry,
      },
    ]);
    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_session_status", { meetingUrl: "/meet/abc" })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as {
      pendingConsentRequests: Array<{ id: string; field: string; proposedValue: unknown }>;
    };
    expect(sc.pendingConsentRequests).toHaveLength(1);
    expect(sc.pendingConsentRequests[0].field).toBe("format");
    expect(sc.pendingConsentRequests[0].proposedValue).toBe("phone");
  });
});

describe("POST /api/mcp — post_message", () => {
  const mockSessionFind = prisma.negotiationSession
    .findFirst as unknown as ReturnType<typeof vi.fn>;
  const mockSessionCreate = prisma.negotiationSession
    .create as unknown as ReturnType<typeof vi.fn>;
  const mockMessageCreate = prisma.message
    .create as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSessionFind.mockReset();
    mockSessionCreate.mockReset();
    mockMessageCreate.mockReset();
  });

  it("persists message + auto-bootstraps session on first contact", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_1", userId: "u1", rules: {}, sourceRuleId: null },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockSessionFind.mockResolvedValueOnce(null); // no existing session
    mockSessionCreate.mockResolvedValueOnce({
      id: "sess_new",
      linkId: "link_1",
      hostId: "u1",
      status: "active",
    });
    mockMessageCreate.mockResolvedValueOnce({ id: "msg_1" });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("post_message", {
          meetingUrl: "/meet/abc",
          text: "Hi — proposing Friday 10am.",
          clientMeta: { clientType: "external_agent" },
        })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as {
      ok: boolean;
      messageId: string;
      sessionId: string;
    };
    expect(sc.ok).toBe(true);
    expect(sc.messageId).toBe("msg_1");
    expect(sc.sessionId).toBe("sess_new");
  });

  it("refuses session_terminal on cancelled session", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_1", userId: "u1", rules: {}, sourceRuleId: null },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockSessionFind.mockResolvedValueOnce({
      id: "sess_1",
      linkId: "link_1",
      hostId: "u1",
      status: "cancelled",
    });
    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("post_message", {
          meetingUrl: "/meet/abc",
          text: "hello",
        })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as { ok: boolean; reason: string };
    expect(sc.ok).toBe(false);
    expect(sc.reason).toBe("session_terminal");
  });
});

describe("POST /api/mcp — propose_parameters", () => {
  const mockSessionFind = prisma.negotiationSession
    .findFirst as unknown as ReturnType<typeof vi.fn>;
  const mockSessionUpdate = prisma.negotiationSession
    .update as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSessionFind.mockReset();
    mockUserFind.mockReset();
    mockSessionUpdate.mockClear();
  });

  it("accepts writeable fields, rejects locked fields with field_locked", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: {
        id: "link_1",
        userId: "u1",
        // format is locked (link rule); duration is open
        rules: { format: "video" },
        sourceRuleId: null,
      },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockSessionFind.mockResolvedValueOnce({
      id: "sess_1",
      linkId: "link_1",
      hostId: "u1",
      status: "active",
    });
    mockUserFind.mockResolvedValueOnce({
      preferences: { explicit: { timezone: "UTC" } },
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("propose_parameters", {
          meetingUrl: "/meet/abc",
          sessionId: "sess_1",
          proposal: { format: "phone", duration: 45 },
        })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as {
      ok: boolean;
      results: Array<{ field: string; accepted: boolean; reason?: string }>;
    };
    expect(sc.ok).toBe(true);
    const byField = Object.fromEntries(sc.results.map((r) => [r.field, r]));
    expect(byField.format.accepted).toBe(false);
    expect(byField.format.reason).toBe("field_locked");
    expect(byField.duration.accepted).toBe(true);
    // Only duration should be persisted — format was rejected.
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { id: "sess_1" },
      data: { duration: 45 },
    });
  });

  it("action=defer_to_host_envoy short-circuits every field", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_1", userId: "u1", rules: {}, sourceRuleId: null },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockSessionFind.mockResolvedValueOnce({
      id: "sess_1",
      linkId: "link_1",
      hostId: "u1",
      status: "active",
    });
    mockUserFind.mockResolvedValueOnce({ preferences: {} });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("propose_parameters", {
          meetingUrl: "/meet/abc",
          sessionId: "sess_1",
          proposal: { duration: 45 },
          action: "defer_to_host_envoy",
        })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as {
      ok: boolean;
      results: Array<{ accepted: boolean; reason?: string }>;
    };
    expect(sc.ok).toBe(true);
    expect(sc.results[0].accepted).toBe(false);
    expect(sc.results[0].reason).toBe("deferred_to_host_envoy");
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp — propose_lock", () => {
  const mockSessionFind = prisma.negotiationSession
    .findFirst as unknown as ReturnType<typeof vi.fn>;
  const mockSessionCreate = prisma.negotiationSession
    .create as unknown as ReturnType<typeof vi.fn>;
  const mockSessionUpdate = prisma.negotiationSession
    .update as unknown as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockSessionFind.mockReset();
    mockSessionCreate.mockReset();
    mockSessionUpdate.mockReset().mockResolvedValue({});
    mockUserFind.mockReset();
    const { confirmBooking } = await import("@/lib/confirm-pipeline");
    (confirmBooking as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("happy path: bootstraps session, calls confirmBooking, maps to confirmed envelope", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: {
        id: "link_1",
        userId: "u1",
        rules: { duration: 30 },
        sourceRuleId: null,
      },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockUserFind.mockResolvedValueOnce({ name: "Hanna" });
    mockSessionFind.mockResolvedValueOnce(null);
    mockSessionCreate.mockResolvedValueOnce({
      id: "sess_new",
      linkId: "link_1",
      hostId: "u1",
      status: "active",
    });
    const { confirmBooking } = await import("@/lib/confirm-pipeline");
    (confirmBooking as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        outcome: "success",
        status: "confirmed",
        dateTime: "2026-05-01T15:00:00.000Z",
        duration: 30,
        format: "video",
        location: null,
        meetLink: "https://meet.google.com/xxx",
        emailSent: true,
        attempt: {
          outcome: "success",
          error: null,
          sessionId: "sess_new",
          slotStart: new Date(),
          slotEnd: new Date(),
        },
      });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("propose_lock", {
          meetingUrl: "/meet/abc",
          slot: { start: "2026-05-01T15:00:00Z" },
          guest: { email: "alice@example.com", name: "Alice" },
        })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as {
      ok: boolean;
      status: string;
      sessionId: string;
      meetLink?: string;
    };
    expect(sc.ok).toBe(true);
    expect(sc.status).toBe("confirmed");
    expect(sc.sessionId).toBe("sess_new");
    expect(sc.meetLink).toBe("https://meet.google.com/xxx");
  });

  it("maps confirmBooking refusal (slot_mismatch) to wire refusal", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      link: { id: "link_1", userId: "u1", rules: {}, sourceRuleId: null },
      parsed: { slug: "abc", code: null },
      rateLimit: { ok: true, result: {} },
    });
    mockUserFind.mockResolvedValueOnce({ name: "Hanna" });
    mockSessionFind.mockResolvedValueOnce({
      id: "sess_1",
      linkId: "link_1",
      hostId: "u1",
      status: "agreed",
    });
    const { confirmBooking } = await import("@/lib/confirm-pipeline");
    (confirmBooking as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        reason: "slot_mismatch",
        message: "Already agreed at a different time.",
        attempt: {
          outcome: "slot_mismatch",
          error: null,
          sessionId: "sess_1",
          slotStart: null,
          slotEnd: null,
        },
      });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("propose_lock", {
          meetingUrl: "/meet/abc",
          slot: { start: "2026-05-01T15:00:00Z" },
          guest: { email: "alice@example.com", name: "Alice" },
        })
      )
    );
    const rpc = await readJsonRpc(res);
    const sc = rpc.result?.structuredContent as { ok: boolean; reason: string };
    expect(sc.ok).toBe(false);
    expect(sc.reason).toBe("slot_mismatch");
  });
});

describe("POST /api/mcp — pipeline-blocked tools are discoverable", () => {
  it("cancel_meeting returns isError:true blocked stub", async () => {
    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("cancel_meeting", { meetingUrl: "/meet/abc" })
      )
    );
    const rpc = await readJsonRpc(res);
    expect(rpc.result?.isError).toBe(true);
    const sc = rpc.result?.structuredContent;
    expect(sc?.ok).toBe(false);
    expect(String(sc?.message)).toMatch(/not yet implemented/);
  });

  it("reschedule_meeting returns isError:true blocked stub", async () => {
    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("reschedule_meeting", {
          meetingUrl: "/meet/abc",
          newSlot: { start: "2026-05-01T15:00:00Z" },
        })
      )
    );
    const rpc = await readJsonRpc(res);
    expect(rpc.result?.isError).toBe(true);
    const sc = rpc.result?.structuredContent;
    expect(sc?.ok).toBe(false);
    expect(String(sc?.message)).toMatch(/not yet implemented/);
  });
});
