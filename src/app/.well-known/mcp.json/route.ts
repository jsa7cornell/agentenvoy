/**
 * `/.well-known/mcp.json` — MCP discovery manifest.
 *
 * External agents hit this endpoint first (per the MCP discovery convention)
 * to learn:
 *   - where the MCP server lives (`endpoint`)
 *   - what transport it speaks (`streamable-http`)
 *   - which tools are available and their wire contracts (derived from the
 *     `MCP_TOOLS` registry — single source of truth, can't drift from the
 *     handlers in `src/lib/mcp/tools.ts`)
 *
 * The auth model is URL-as-capability-token: the agent does not get a token
 * from this endpoint. It uses the meeting URL (`/meet/<slug>`) it was given
 * as the `meetingUrl` argument to every tool call. The `auth` block here
 * describes that convention so agents know where the bearer comes from.
 *
 * Served at `GET /.well-known/mcp.json`. Static-ish — the tool list can only
 * change with a deploy, so a short CDN cache is fine.
 */
import { NextResponse } from "next/server";
import { MCP_TOOLS, type McpToolName } from "@/lib/mcp/schemas";
import { z } from "zod";

export const runtime = "nodejs";
// Allow edge caching. The manifest only changes on deploy.
export const revalidate = 300;

const BASE_URL = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";

export function GET() {
  const tools = (Object.keys(MCP_TOOLS) as McpToolName[]).map((name) => {
    const tool = MCP_TOOLS[name];
    return {
      name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input),
      outputSchema: z.toJSONSchema(tool.output),
    };
  });

  return NextResponse.json(
    {
      schemaVersion: "2026-04-18",
      server: { name: "agentenvoy", version: "1.0.0" },
      endpoint: `${BASE_URL}/api/mcp`,
      transport: {
        type: "streamable-http",
        sessionIdSupport: false,
      },
      auth: {
        // URL-as-capability-token (parent MCP proposal §2.1). The agent
        // passes the meeting URL it was given as `meetingUrl` to every tool
        // call. No bearer exchange — possession of the URL is authorization.
        type: "url-capability",
        tokenParam: "meetingUrl",
        urlPattern: "/meet/{slug}[?c={code}]",
      },
      docs: {
        description: `${BASE_URL}/llms.txt`,
        humanSite: BASE_URL,
      },
      tools,
    },
    {
      headers: {
        "cache-control": "public, max-age=60, s-maxage=300",
      },
    }
  );
}
