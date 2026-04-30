/**
 * Host-side MCP Streamable HTTP endpoint.
 *
 * POST (and GET for SSE streams) /api/mcp/host
 *
 * Auth: PAT bearer `agentenvoy_pat_live_<…>`, validated by `auth.ts`.
 * Scope: checked per-tool at dispatch in `host-tools.ts`.
 *
 * Stateless mode — one McpServer + transport per request, same pattern as
 * the guest route at /api/mcp/route.ts. No per-instance cross-request state.
 *
 * PR-1: auth + PAT infra.
 * PR-3a: create_link tool added to registerHostMcpTools.
 *
 * Proposal: 2026-04-29_host-side-mcp-act-as-me_reviewed-2026-04-29_decided-2026-04-29.md §2.3
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextRequest, NextResponse } from "next/server";
import { authorizeHostMcpCall } from "./auth";
import { checkHostPatRateLimit } from "@/lib/mcp/auth";
import { registerHostMcpTools } from "@/lib/mcp/host-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOST_MCP_SERVER_INFO = {
  name: "agentenvoy-host",
  version: "1.0.0",
} as const;

function unauthorized(reason: string): NextResponse {
  return NextResponse.json({ error: reason }, { status: 401 });
}

async function handle(req: NextRequest): Promise<NextResponse | Response> {
  // Auth is checked BEFORE the MCP transport. The transport never sees
  // unauthenticated traffic — this is the auth choke-point.
  //
  // Scope is NOT checked here. It used to be — a union-check across every
  // registered tool's requiredScope — which made `read`-only PATs reject at
  // the route layer because the SDK had no way to advertise a different
  // tool subset per token. Scope is now checked per-tool in
  // `wrapWithScopeCheck` (see `lib/mcp/host-tools.ts`), so a read-only
  // token can list/call read tools but gets `scope_denied` per-call on
  // write tools. Decided: 2026-04-30 stabilization-package proposal §B5.
  const principalCtx = await authorizeHostMcpCall(
    req.headers.get("authorization")
  );

  if (!principalCtx.ok) {
    return unauthorized(principalCtx.reason);
  }

  // Per-PAT rate limit. Fail-closed — every host call (read or write) draws
  // from the same per-token bucket. WISHLIST #39 + stabilization-package §B.
  const rate = await checkHostPatRateLimit(principalCtx.tokenId);
  if (!rate.ok) {
    return NextResponse.json(
      { error: rate.error, retryAfterSeconds: rate.retryAfterSeconds },
      {
        status: rate.error === "rate_limit_exceeded" ? 429 : 503,
        headers: { "retry-after": String(rate.retryAfterSeconds) },
      }
    );
  }

  const server = new McpServer(HOST_MCP_SERVER_INFO);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  registerHostMcpTools(server, principalCtx);

  await server.connect(transport);

  return transport.handleRequest(req);
}

export async function POST(req: NextRequest): Promise<NextResponse | Response> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  return handle(req);
}
