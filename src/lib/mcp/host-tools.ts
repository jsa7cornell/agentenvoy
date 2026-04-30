/**
 * Host-side MCP tool handlers.
 *
 * `registerHostMcpTools(server, principalCtx)` wires each handler into a
 * per-request `McpServer`. Auth was checked by the route before this is
 * called — handlers get a pre-resolved `HostPrincipalContext`. Scope is
 * checked PER-TOOL inside this module (`wrapWithScopeCheck`), not at the
 * route level. This is the load-bearing fix for the read-only-PAT bug:
 * the previous union-check at route.ts rejected any request unless the
 * token's scope satisfied EVERY registered tool's requiredScope, making
 * `read`-scoped PATs structurally non-functional.
 *
 * Stabilization package §3 Group A (B5 promoted), proposal:
 * `2026-04-30_host-mcp-stabilization-package_reviewed-2026-04-30_decided-2026-04-30.md`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hasScope, type HostPrincipalContext } from "@/app/api/mcp/host/auth";
import {
  HOST_MCP_TOOLS,
  createLinkInput,
  type HostMcpToolName,
} from "@/lib/mcp/host-schemas";
import { handleCreateLink } from "@/agent/actions";
import { writeMcpCallLog } from "@/lib/mcp/call-log";

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

/**
 * Wrap a handler with a per-tool scope check. The principal's scope set is
 * checked against the tool's `requiredScope` at call time — so a `read`-only
 * PAT can call read tools, a `schedule` PAT can call read + schedule tools,
 * and an `admin` PAT can call everything (per the cascade in `auth.ts`).
 *
 * Returning a typed `scope_denied` is intentionally per-call rather than
 * per-request — the agent can keep its connection and try a different tool
 * without re-handshaking.
 */
function wrapWithScopeCheck(
  toolName: HostMcpToolName,
  principalCtx: HostPrincipalContext & { ok: true },
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  const required = HOST_MCP_TOOLS[toolName].requiredScope;
  return async (args) => {
    if (!hasScope(principalCtx.scopes, required)) {
      return fail(
        "scope_denied",
        `This tool requires scope "${required}". Your token has: ${principalCtx.scopes.join(", ")}.`
      );
    }
    return handler(args);
  };
}

/**
 * Wrap a handler with MCPCallLog writing. Mirrors guest-side `withCallLogging`
 * (`tools.ts:1175`) but populates host fields per parent §7.4: `userId` set,
 * `linkId` null, `principal: { kind: "host_pat", tokenId, displayId }`.
 *
 * Same fire-and-forget semantics — log writes never block the response.
 */
function withHostCallLogging(
  toolName: HostMcpToolName,
  principalCtx: HostPrincipalContext & { ok: true },
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    const started = Date.now();
    const result = await handler(args);
    const latencyMs = Date.now() - started;

    // Result content[0] is JSON-serialized text per ok()/fail() helpers.
    let response: Record<string, unknown> = {};
    try {
      const first = result.content?.[0];
      if (first && first.type === "text" && typeof first.text === "string") {
        response = JSON.parse(first.text) as Record<string, unknown>;
      }
    } catch {
      response = { ok: false, reason: "log_parse_failed" };
    }

    void writeMcpCallLog({
      tool: toolName,
      userId: principalCtx.userId,
      principal: {
        kind: "host_pat",
        tokenId: principalCtx.tokenId,
        displayId: principalCtx.displayId,
      },
      requestArgs: args,
      response,
      latencyMs,
    });

    return result;
  };
}

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
    // Composition: scope check OUTSIDE call logging — denied calls still get
    // logged (signal: which tokens are trying which tools they shouldn't).
    const wrapped = withHostCallLogging(
      name,
      principalCtx,
      wrapWithScopeCheck(name, principalCtx, handlers[name])
    );
    server.registerTool(
      name,
      { description: tool.description, inputSchema: inputShape },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapped as any
    );
  }
}
