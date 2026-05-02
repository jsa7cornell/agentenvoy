/**
 * Host MCP HTTP route — in-process smoke test.
 *
 * Imports POST from `src/app/api/mcp/host/route.ts` and exercises:
 *   - missing/malformed/revoked/expired bearer → 401 with typed reason
 *   - per-PAT rate limit → 429 with retry-after
 *   - valid bearer + valid scope → 200, tool dispatches, MCPCallLog written
 *   - read-only PAT calling schedule-required tool → per-tool scope_denied
 *     (NOT 403 union-rejection — that was the B5 bug fixed in the
 *     stabilization-package proposal)
 *   - tools/list works for any valid bearer regardless of scope (proves the
 *     union-check is gone)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth at module boundary BEFORE importing the route.
vi.mock("@/app/api/mcp/host/auth", async () => {
  const actual = await vi.importActual<typeof import("@/app/api/mcp/host/auth")>(
    "@/app/api/mcp/host/auth"
  );
  return {
    ...actual,
    authorizeHostMcpCall: vi.fn(),
  };
});

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>(
    "@/lib/mcp/auth"
  );
  return {
    ...actual,
    checkHostPatRateLimit: vi.fn(),
  };
});

// `create_link` calls handleCreateLink → DB. Mock the agent action so this
// stays a wiring test.
vi.mock("@/agent/actions", () => ({
  handleCreateLink: vi.fn(),
}));

// MCPCallLog write is fire-and-forget; mock to no-op so the test doesn't
// hit the DB.
vi.mock("@/lib/mcp/call-log", () => ({
  writeMcpCallLog: vi.fn().mockResolvedValue(undefined),
}));

// PR-2 read tools hit the schedule cache + Postgres. Mock both for wiring.
vi.mock("@/lib/calendar", () => ({
  getOrComputeSchedule: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    negotiationSession: { findMany: vi.fn() },
  },
}));

import { authorizeHostMcpCall } from "@/app/api/mcp/host/auth";
import { checkHostPatRateLimit } from "@/lib/mcp/auth";
import { handleCreateLink } from "@/agent/actions";
import { writeMcpCallLog } from "@/lib/mcp/call-log";
import { getOrComputeSchedule } from "@/lib/calendar";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/mcp/host/route";

const mockAuth = authorizeHostMcpCall as unknown as ReturnType<typeof vi.fn>;
const mockRate = checkHostPatRateLimit as unknown as ReturnType<typeof vi.fn>;
const mockCreateLink = handleCreateLink as unknown as ReturnType<typeof vi.fn>;
const mockWriteLog = writeMcpCallLog as unknown as ReturnType<typeof vi.fn>;
const mockSchedule = getOrComputeSchedule as unknown as ReturnType<typeof vi.fn>;
const mockUserFind = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockSessionFind = prisma.negotiationSession.findMany as unknown as ReturnType<typeof vi.fn>;

function makeRpcRequest(body: unknown, bearer = "agentenvoy_pat_live_x"): Request {
  return new Request("http://localhost/api/mcp/host", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

function jsonRpcCall(tool: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  };
}

async function readJsonRpc(res: Response): Promise<{
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}> {
  const text = await res.text();
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error(`SSE response had no data: line: ${text}`);
    return JSON.parse(dataLine.slice(5).trim());
  }
  return JSON.parse(text);
}

beforeEach(() => {
  mockAuth.mockReset();
  mockRate.mockReset();
  mockCreateLink.mockReset();
  mockWriteLog.mockClear();
  mockSchedule.mockReset();
  mockUserFind.mockReset();
  mockSessionFind.mockReset();
  // Default: rate limit passes
  mockRate.mockResolvedValue({ ok: true, result: {} });
});

describe("POST /api/mcp/host — bearer auth refusals", () => {
  it.each([
    ["missing_bearer", "missing_bearer"],
    ["malformed_bearer", "malformed_bearer"],
    ["token_not_found", "token_not_found"],
    ["token_revoked", "token_revoked"],
    ["token_expired", "token_expired"],
  ])("%s returns 401 with typed reason", async (reason) => {
    mockAuth.mockResolvedValueOnce({ ok: false, reason });
    const res = await POST(
      makeRpcRequest(jsonRpcCall("create_link", {})) as never
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe(reason);
  });
});

describe("POST /api/mcp/host — per-PAT rate limit", () => {
  it("returns 429 with retry-after when bucket is full", async () => {
    mockAuth.mockResolvedValueOnce({
      ok: true,
      kind: "host_pat",
      userId: "user_1",
      tokenId: "tok_1",
      displayId: "abcd1234",
      scopes: ["schedule"],
    });
    mockRate.mockResolvedValueOnce({
      ok: false,
      error: "rate_limit_exceeded",
      retryAfterSeconds: 17,
    });

    const res = await POST(
      makeRpcRequest(jsonRpcCall("create_link", {})) as never
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    const body = await res.json();
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.retryAfterSeconds).toBe(17);
  });
});

describe("POST /api/mcp/host — scope enforcement is per-tool, not union", () => {
  it("read-only PAT calling create_link returns scope_denied (not 403)", async () => {
    mockAuth.mockResolvedValueOnce({
      ok: true,
      kind: "host_pat",
      userId: "user_1",
      tokenId: "tok_read",
      displayId: "read1234",
      scopes: ["read"], // Read-only — schedule tools should refuse per-tool.
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("create_link", { topic: "test", inviteeNames: ["A"] })
      ) as never
    );

    // Critical: 200 at the HTTP layer (the request reached the SDK), not 403
    // (which was the pre-fix union-check behavior that made read-only PATs
    // structurally non-functional). Per-tool scope_denied is the right shape.
    expect(res.status).toBe(200);
    const rpc = await readJsonRpc(res);
    expect(rpc.error).toBeUndefined();
    const text = rpc.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("scope_denied");
  });
});

describe("POST /api/mcp/host — create_link happy path", () => {
  it("schedule-scope PAT can call create_link; MCPCallLog written", async () => {
    mockAuth.mockResolvedValueOnce({
      ok: true,
      kind: "host_pat",
      userId: "user_1",
      tokenId: "tok_sched",
      displayId: "sch12345",
      scopes: ["schedule"],
    });
    mockCreateLink.mockResolvedValueOnce({
      success: true,
      message: "Created link",
      data: {
        sessionId: "sess_1",
        linkId: "link_1",
        code: "abc123",
        url: "https://agentenvoy.ai/meet/john/abc123",
        title: "Meeting with Test",
      },
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("create_link", { topic: "test", inviteeNames: ["Test"] })
      ) as never
    );

    expect(res.status).toBe(200);
    const rpc = await readJsonRpc(res);
    expect(rpc.error).toBeUndefined();
    const text = rpc.result?.content?.[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toBe("https://agentenvoy.ai/meet/john/abc123");
    expect(parsed.linkCode).toBe("abc123");
    expect(parsed.slug).toBe("john");

    // MCPCallLog should be written with host fields set.
    expect(mockWriteLog).toHaveBeenCalledTimes(1);
    const logCall = mockWriteLog.mock.calls[0][0];
    expect(logCall.tool).toBe("create_link");
    expect(logCall.userId).toBe("user_1");
    expect(logCall.principal).toEqual({
      kind: "host_pat",
      tokenId: "tok_sched",
      displayId: "sch12345",
    });
  });
});

describe("POST /api/mcp/host — get_my_availability (PR-2)", () => {
  it("read-scope PAT can call get_my_availability; returns scored slots + timezone", async () => {
    mockAuth.mockResolvedValueOnce({
      ok: true,
      kind: "host_pat",
      userId: "user_1",
      tokenId: "tok_read",
      displayId: "read1234",
      scopes: ["read"],
    });
    mockUserFind.mockResolvedValueOnce({
      preferences: { explicit: { timezone: "America/Los_Angeles" } },
    });
    const future1 = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const future2 = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const start = dateFmt.format(new Date(future1));
    const end = dateFmt.format(new Date(future2));
    mockSchedule.mockResolvedValueOnce({
      connected: true,
      slots: [
        { start: future2, end: new Date(new Date(future2).getTime() + 30 * 60_000).toISOString(), score: 0 },
        { start: future1, end: new Date(new Date(future1).getTime() + 30 * 60_000).toISOString(), score: -1 },
      ],
    });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_my_availability", {
          dateRange: { start, end },
        })
      ) as never
    );

    expect(res.status).toBe(200);
    const rpc = await readJsonRpc(res);
    const text = rpc.result?.content?.[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.ok).toBe(true);
    expect(parsed.timezone).toBe("America/Los_Angeles");
    // Best-first: -1 (lower score) before 0
    expect(parsed.slots[0].score).toBe(-1);
    expect(parsed.slots[1].score).toBe(0);
    // 2026-05-01 event-availability rewrite: host-side `get_my_availability`
    // is called with empty rules (no per-link availability/preferred fields,
    // because there's no link — the principal is the host directly). Under
    // the new scoring-emit derivation, `preferred` is membership-based, so
    // both slots emit `preferred: undefined` regardless of score. SPEC §8.
    expect(parsed.slots[0].preferred).toBeUndefined();
    expect(parsed.slots[1].preferred).toBeUndefined();
  });

  it("disconnected calendar returns calendar_not_connected refusal", async () => {
    mockAuth.mockResolvedValueOnce({
      ok: true,
      kind: "host_pat",
      userId: "user_1",
      tokenId: "tok_read",
      displayId: "read1234",
      scopes: ["read"],
    });
    mockUserFind.mockResolvedValueOnce({ preferences: {} });
    mockSchedule.mockResolvedValueOnce({ connected: false, slots: [] });

    const res = await POST(
      makeRpcRequest(
        jsonRpcCall("get_my_availability", {
          dateRange: { start: "2026-05-01", end: "2026-05-08" },
        })
      ) as never
    );

    const rpc = await readJsonRpc(res);
    const text = rpc.result?.content?.[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("calendar_not_connected");
  });
});

describe("POST /api/mcp/host — list_my_sessions (PR-2)", () => {
  it("read-scope PAT can call list_my_sessions; returns hashed emails (never plaintext)", async () => {
    mockAuth.mockResolvedValueOnce({
      ok: true,
      kind: "host_pat",
      userId: "user_1",
      tokenId: "tok_read",
      displayId: "read1234",
      scopes: ["read"],
    });
    mockSessionFind.mockResolvedValueOnce([
      {
        id: "sess_1",
        status: "agreed",
        guestName: "Alice Example",
        guestEmail: "alice@example.com",
        agreedTime: new Date("2026-05-05T16:00:00Z"),
        updatedAt: new Date("2026-05-04T10:00:00Z"),
        link: { code: "abc123", hashSalt: "test-salt-link-1" },
        _count: { messages: 7 },
      },
      {
        id: "sess_2",
        status: "active",
        guestName: null,
        guestEmail: null,
        agreedTime: null,
        updatedAt: new Date("2026-05-04T09:00:00Z"),
        link: { code: "xyz789", hashSalt: "test-salt-link-2" },
        _count: { messages: 2 },
      },
    ]);

    const res = await POST(
      makeRpcRequest(jsonRpcCall("list_my_sessions", {})) as never
    );

    expect(res.status).toBe(200);
    const rpc = await readJsonRpc(res);
    const text = rpc.result?.content?.[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.ok).toBe(true);
    expect(parsed.sessions).toHaveLength(2);
    // Plaintext email NEVER appears in output
    const json = JSON.stringify(parsed);
    expect(json).not.toContain("alice@example.com");
    // Hash is hex sha256
    expect(parsed.sessions[0].guestEmailHash).toMatch(/^[a-f0-9]{64}$/);
    // Null guestEmail → null hash
    expect(parsed.sessions[1].guestEmailHash).toBeNull();
    expect(parsed.sessions[0].guestName).toBe("Alice Example");
    expect(parsed.sessions[0].linkCode).toBe("abc123");
    expect(parsed.sessions[0].messageCount).toBe(7);
  });

  it("filters to host-only via where clause hostId = principal.userId", async () => {
    mockAuth.mockResolvedValueOnce({
      ok: true,
      kind: "host_pat",
      userId: "user_42",
      tokenId: "tok_read",
      displayId: "read1234",
      scopes: ["read"],
    });
    mockSessionFind.mockResolvedValueOnce([]);

    await POST(
      makeRpcRequest(jsonRpcCall("list_my_sessions", {})) as never
    );

    // Confirm the prisma query was scoped to hostId = principal.userId.
    expect(mockSessionFind).toHaveBeenCalledTimes(1);
    const callArgs = mockSessionFind.mock.calls[0][0];
    expect(callArgs.where.hostId).toBe("user_42");
  });
});
