/**
 * MCP Streamable HTTP endpoint.
 *
 * POST (and GET for SSE streams) /api/mcp
 *
 * Stateless mode: a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport`
 * per request. This matches Vercel's serverless execution model — no
 * per-instance cross-request state is safe to rely on. Sessions are out of
 * scope for v1 (no streaming/resumable tools in the current registry).
 *
 * All tools are registered via `registerMcpTools(server)`. Adding a new
 * tool means editing the registry in `src/lib/mcp/schemas.ts` + the handler
 * in `src/lib/mcp/tools.ts` — not this route.
 *
 * Discovery:
 *   - `public/.well-known/mcp.json` advertises this endpoint (next chunk).
 *   - `Link: <.../api/mcp>; rel="agent-api"` added to `/meet/*` pages via
 *     middleware (next chunk).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerMcpTools } from "@/lib/mcp/tools";

// Next.js App Router — run on Node runtime (Prisma requires it; edge won't work).
export const runtime = "nodejs";
// MCP tool handlers may do DB writes; opt out of caching.
export const dynamic = "force-dynamic";

const MCP_SERVER_INFO = {
  name: "agentenvoy",
  version: "1.0.0",
} as const;

async function handle(req: Request): Promise<Response> {
  const server = new McpServer(MCP_SERVER_INFO);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless — no session ID.
    sessionIdGenerator: undefined,
    // Prefer JSON responses over SSE for single-turn tool calls. Tools that
    // stream (propose_parameters w/ defer; post_message envoy reply) will
    // opt in per-call via the SDK's notification channel in later chunks.
    enableJsonResponse: true,
  });

  // Register tools FIRST — the SDK errors "Cannot register capabilities
  // after connecting to transport" if you connect before registering.
  registerMcpTools(server);

  // `server.connect(transport)` wires the JSON-RPC dispatcher. Stateless
  // pattern — no need to listen for `onclose` in this path; the transport
  // completes when `handleRequest` resolves.
  await server.connect(transport);

  return transport.handleRequest(req);
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}
