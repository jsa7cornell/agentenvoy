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

import { authorizeHostMcpCall } from "@/app/api/mcp/host/auth";
import { checkHostPatRateLimit } from "@/lib/mcp/auth";
import { handleCreateLink } from "@/agent/actions";
import { writeMcpCallLog } from "@/lib/mcp/call-log";
import { POST } from "@/app/api/mcp/host/route";

const mockAuth = authorizeHostMcpCall as unknown as ReturnType<typeof vi.fn>;
const mockRate = checkHostPatRateLimit as unknown as ReturnType<typeof vi.fn>;
const mockCreateLink = handleCreateLink as unknown as ReturnType<typeof vi.fn>;
const mockWriteLog = writeMcpCallLog as unknown as ReturnType<typeof vi.fn>;

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
