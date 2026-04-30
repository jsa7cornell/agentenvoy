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

// Tools that are registered in MCP_TOOLS but should not be advertised in the
// public manifest. Today: `reschedule_meeting` returns `tool_not_implemented`
// and is gated on the in-draft reschedule-pipeline proposal
// (`proposals/2026-04-29_mcp-reschedule-meeting-patch-in-place.md`). We keep
// the SDK-side registration so any agent that already cached the tool name
// gets a typed refusal rather than "unknown tool", but we narrow static
// discovery so fresh agents don't try a tool that doesn't work.
const MANIFEST_HIDDEN_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>([
  "reschedule_meeting",
]);

export function GET() {
  const tools = (Object.keys(MCP_TOOLS) as McpToolName[])
    .filter((name) => !MANIFEST_HIDDEN_TOOLS.has(name))
    .map((name) => {
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
        // Path-segment is the canonical form (handleCreateLink mints this);
        // query-param is the legacy form. Both are accepted.
        urlPattern: "/meet/{slug}[/{code} | ?c={code}]",
      },
      // Additional endpoints. Host-side endpoint (`/api/mcp/host`) is for the
      // host's own AI assistant — bearer PAT auth, not URL-capability. Listed
      // here so a host's agent doing dynamic discovery can find it; guest
      // agents should keep using `/api/mcp` (the primary `endpoint` above).
      additionalEndpoints: [
        {
          url: `${BASE_URL}/api/mcp/host`,
          purpose: "host-self-service",
          auth: {
            type: "pat-bearer",
            scheme: "Bearer agentenvoy_pat_live_<token>",
            scopes: ["read", "schedule", "admin"],
          },
        },
      ],
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
