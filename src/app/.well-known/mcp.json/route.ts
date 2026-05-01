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
// public manifest. Empty today (`reschedule_meeting` was previously hidden
// while its stub returned `tool_not_implemented`; the patch-in-place
// implementation shipped 2026-04-30, so it's now live and visible).
//
// If a future tool ships as a stub awaiting a backing pipeline, add it here
// AND wire its handler to return `tool_not_implemented` (per the
// stub-discipline comment on `rescheduleMeetingOutput.tool_not_implemented`).
const MANIFEST_HIDDEN_TOOLS: ReadonlySet<McpToolName> = new Set<McpToolName>();

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
        // Hint for registry-style agent runtimes: this endpoint is publicly
        // callable; agents do NOT need to register AgentEnvoy as a connector
        // before issuing tools/call requests. If your runtime defaults to
        // requiring a registered server, you can still call this endpoint
        // ad-hoc via raw HTTPS POST. URL-as-capability auth means no
        // OAuth handshake, no API key, no per-user setup.
        directlyCallable: true,
        connectorInstallRequired: false,
      },
      // Top-level guidance for agent runtimes that read manifests before
      // deciding whether to use a connector framework or raw HTTP. Designed
      // to discourage the "user must add this as an integration first" UX
      // that blocks one-shot guest bookings on registry-style runtimes.
      agentSetup: {
        installRequired: false,
        guidance:
          "POST tools/call requests directly to the endpoint with the meeting URL as the meetingUrl argument. No connector installation, OAuth, or API key required. Agents whose runtime requires a registered MCP server may still add this URL as a custom server, but doing so is not necessary — the endpoint is publicly callable.",
      },
      // Additional endpoints. Host-side endpoint (`/api/mcp/host`) is for the
      // host's own AI assistant — bearer PAT auth, not URL-capability. Listed
      // here so a host's agent doing dynamic discovery can find it; guest
      // agents should keep using `/api/mcp` (the primary `endpoint` above).
      // The `agent.json` entries advertise the single-fetch JSON snapshot
      // surface (per the 2026-04-30 single-fetch-agent-surface proposal).
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
        {
          url: `${BASE_URL}/meet/{slug}/{code}/agent.json`,
          purpose: "agent-snapshot",
          auth: { type: "url-capability", note: "no auth header — possessing the URL is the authorization" },
          method: "GET",
          contentType: "application/agent+json",
          description:
            "Single-fetch JSON snapshot of a contextual link's parameters + scored slot list + booking guidance. For agents that prefer GET-then-POST over JSON-RPC. Same data as MCP get_availability + get_meeting_parameters; defaults: limit=20, no dateRange floor, sorted best-first.",
        },
        {
          url: `${BASE_URL}/meet/{slug}/agent.json`,
          purpose: "agent-snapshot-vanity",
          auth: { type: "url-capability" },
          method: "GET",
          contentType: "application/agent+json",
          description:
            "Bare-vanity form for a host's primary link. Resolves the slug to the host's default link.",
        },
      ],
      // In-page discovery hint — the contextual /meet/<slug>/<code> page
      // server-renders the snapshot as an embedded script tag. Bare-vanity
      // /meet/<slug> does NOT embed (privacy posture: bare URLs are widely
      // shared and crawlable; bookable detail stays behind a deliberate fetch).
      inPageDiscovery: {
        selector: 'script[type="application/agent+json"][data-agent-snapshot]',
        scope: "/meet/{slug}/{code}",
        description:
          "On contextual meet pages, an `<script type=\"application/agent+json\">` tag carries the same snapshot as `/agent.json`. Cold web_fetch agents that can't issue separate API calls can parse this from the page HTML.",
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
