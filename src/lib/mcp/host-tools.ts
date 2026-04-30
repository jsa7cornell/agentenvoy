/**
 * Host-side MCP tool handlers.
 *
 * `registerHostMcpTools(server, principalCtx)` wires each handler into a
 * per-request `McpServer`. Auth and scope were checked by the route before
 * this is called — handlers get a pre-resolved `HostPrincipalContext`.
 *
 * PR-3a: `create_link` only.
 *
 * Proposal: 2026-04-29_host-side-mcp-act-as-me_reviewed-2026-04-29_decided-2026-04-29.md §5.3
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { HostPrincipalContext } from "@/app/api/mcp/host/auth";
import {
  HOST_MCP_TOOLS,
  createLinkInput,
  type HostMcpToolName,
} from "@/lib/mcp/host-schemas";
import { handleCreateLink } from "@/agent/actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }],
  };
}

function fail(reason: string, message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateLinkTool(
  args: z.infer<typeof createLinkInput>,
  userId: string
): Promise<CallToolResult> {
  const params: Record<string, unknown> = {
    topic: args.topic,
    format: args.format,
    duration: args.durationMinutes,
    activity: args.activity,
    activityIcon: args.activityIcon,
    hostNote: args.hostNote,
    timingLabel: args.timingLabel,
    location: args.location,
    inviteeNames: args.inviteeNames ?? [],
  };

  const result = await handleCreateLink(params, userId);

  if (!result.success) {
    const data = result.data as Record<string, unknown> | undefined;
    const errorCode = typeof data?.error === "string" ? data.error : "validation_failed";
    const reason =
      errorCode === "calendar_not_connected"
        ? "calendar_not_connected"
        : errorCode === "no_slug"
          ? "no_slug"
          : "validation_failed";
    return fail(reason, result.message ?? "Link creation failed");
  }

  const d = result.data as {
    sessionId: string;
    linkId: string;
    code: string;
    url: string;
    title: string;
  };

  // Derive the slug from the URL — format is always `<origin>/meet/<slug>/<code>`.
  const urlParts = d.url.split("/meet/");
  const slugAndCode = urlParts[1] ?? "";
  const slug = slugAndCode.split("/")[0] ?? "";

  return ok({ linkCode: d.code, slug, url: d.url });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHostMcpTools(
  server: McpServer,
  principalCtx: HostPrincipalContext & { ok: true }
): void {
  const handlers: Record<
    HostMcpToolName,
    (args: Record<string, unknown>) => Promise<CallToolResult>
  > = {
    create_link: (args) =>
      handleCreateLinkTool(
        args as z.infer<typeof createLinkInput>,
        principalCtx.userId
      ),
  };

  for (const name of Object.keys(HOST_MCP_TOOLS) as HostMcpToolName[]) {
    const tool = HOST_MCP_TOOLS[name];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputShape = (tool.input as any).shape as Record<string, any>;
    server.registerTool(
      name,
      { description: tool.description, inputSchema: inputShape },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handlers[name] as any
    );
  }
}
