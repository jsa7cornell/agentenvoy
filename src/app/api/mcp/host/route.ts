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
import { authorizeHostMcpCall, hasScope } from "./auth";
import { registerHostMcpTools } from "@/lib/mcp/host-tools";
import { HOST_MCP_TOOLS } from "@/lib/mcp/host-schemas";
import type { HostMcpToolName } from "@/lib/mcp/host-schemas";

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
  // Auth is checked BEFORE handing off to the MCP transport. The transport
  // never sees unauthenticated traffic — this is the choke-point per §2.3.
  const principalCtx = await authorizeHostMcpCall(
    req.headers.get("authorization")
  );

  if (!principalCtx.ok) {
    return unauthorized(principalCtx.reason);
  }

  // Scope pre-flight: check that every registered tool's required scope is
  // satisfied. This produces a clear "scope_denied" before the SDK ever runs
  // tool resolution. Individual handlers trust that scope is already verified.
  // (Per §2.3: "The host route's middleware checks requiredScope ⊆ issuedScopes
  // BEFORE the handler runs.")
  //
  // For per-tool scope denial we'd need to intercept after tool selection;
  // for now we check the union and fail the whole request if any tool in the
  // registry requires a scope the token doesn't have. This is safe at PR-3a
  // scope (single tool requiring "schedule"). Per-tool scope denial is a
  // follow-up if the read/schedule split matters in practice.
  for (const name of Object.keys(HOST_MCP_TOOLS) as HostMcpToolName[]) {
    const required = HOST_MCP_TOOLS[name].requiredScope;
    if (!hasScope(principalCtx.scopes, required)) {
      return NextResponse.json(
        { error: "scope_denied", required, issued: principalCtx.scopes },
        { status: 403 }
      );
    }
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
