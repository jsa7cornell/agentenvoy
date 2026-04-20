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
    },
    consentRequest: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
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

describe("POST /api/mcp — not-yet-implemented tools are discoverable", () => {
  it("propose_lock returns isError:true not-implemented stub", async () => {
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
    expect(rpc.result?.isError).toBe(true);
    const sc = rpc.result?.structuredContent;
    expect(sc?.ok).toBe(false);
    expect(String(sc?.message)).toMatch(/not yet implemented/);
  });
});
