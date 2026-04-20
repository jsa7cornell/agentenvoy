/**
 * MCP tool handlers.
 *
 * Thin per-tool functions that:
 *   1. Parse input (already validated by the SDK against `MCP_TOOLS[name].input`).
 *   2. Call `authorizeMcpCall` — one choke-point for URL parsing, link
 *      resolution, rate-limiting. Returns on any auth failure.
 *   3. Call the underlying pipeline / resolver.
 *   4. Shape the response to match `MCP_TOOLS[name].output`.
 *
 * Each handler is pure-ish — side effects (DB writes, side-effect dispatch)
 * live inside the pipelines (confirm-pipeline.ts, etc.), not here.
 *
 * The HTTP route (src/app/api/mcp/route.ts) calls `registerMcpTools(server)`
 * to wire every handler into an `McpServer` instance per-request. Stateless
 * mode — no cross-request state lives here.
 */
import { prisma } from "@/lib/prisma";
import { getUserTimezone } from "@/lib/timezone";
import type { LinkRules, UserPreferences, CompiledRules } from "@/lib/scoring";
import { authorizeMcpCall, type AuthorizeResult } from "@/lib/mcp/auth";
import { resolveParameters } from "@/lib/mcp/parameter-resolver";
import {
  MCP_TOOLS,
  type McpToolName,
  getMeetingParametersInput,
} from "@/lib/mcp/schemas";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Response envelope used by the SDK (CallToolResult shape).
// ---------------------------------------------------------------------------

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Build a CallToolResult from a JSON-shaped response. The SDK requires a
 * `content` array; we also attach `structuredContent` so clients that prefer
 * typed access (e.g. Anthropic tool_use) can skip the JSON.parse step.
 */
function asCallResult(
  json: Record<string, unknown>,
  opts: { isError?: boolean } = {}
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    structuredContent: json,
    ...(opts.isError ? { isError: true } : {}),
  };
}

// Map auth-error codes onto the user-facing refusal reasons the schemas allow.
function authErrorToRefusal(
  auth: Extract<AuthorizeResult, { ok: false }>
): { reason: string; message: string; retryAfterSeconds?: number } {
  switch (auth.error) {
    case "invalid_url":
    case "not_meeting_path":
    case "link_not_found":
      return {
        reason: "link_not_found",
        message: "Meeting URL did not resolve to an active link.",
      };
    case "link_expired":
      return {
        reason: "link_expired",
        message: "This meeting link has expired.",
      };
    case "rate_limit_exceeded":
    case "rate_limit_store_unavailable":
      return {
        reason: "rate_limited",
        message: "Too many requests — back off and retry.",
        retryAfterSeconds: auth.retryAfterSeconds,
      };
    default:
      return {
        reason: "link_not_found",
        message: "Meeting URL did not resolve.",
      };
  }
}

// ---------------------------------------------------------------------------
// Handler: get_meeting_parameters
// ---------------------------------------------------------------------------

export async function handleGetMeetingParameters(
  args: z.infer<typeof getMeetingParametersInput>
): Promise<CallToolResult> {
  const auth = await authorizeMcpCall({
    meetingUrl: args.meetingUrl,
    tool: "get_meeting_parameters",
  });
  if (!auth.ok) {
    const refusal = authErrorToRefusal(auth);
    return asCallResult({ ok: false, ...refusal });
  }

  const { link } = auth;

  // Load the host's preferences for the fallback chain.
  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { preferences: true },
  });
  const hostPreferences = (host?.preferences ?? null) as UserPreferences | null;
  const hostTimezone = getUserTimezone(
    hostPreferences as Record<string, unknown> | null
  );

  // `compiledRules` lives inside preferences.explicit.compiled (scoring.ts:1100).
  const compiledRules =
    ((hostPreferences?.explicit as Record<string, unknown> | undefined)
      ?.compiled as CompiledRules | undefined) ?? null;

  const rules = (link.rules ?? {}) as LinkRules;
  const slotStart = args.slotStart ? new Date(args.slotStart) : undefined;

  const parameters = resolveParameters({
    rules,
    hostPreferences,
    hostTimezone,
    slotStart,
    compiledRules,
  });

  return asCallResult({
    ok: true,
    meetingUrl: args.meetingUrl,
    parameters,
    rules: {
      ...(rules.activity ? { activity: rules.activity } : {}),
      ...(rules.activityIcon ? { activityIcon: rules.activityIcon } : {}),
      ...(rules.timingLabel ? { timingLabel: rules.timingLabel } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Stub handlers for the 7 tools landing in later chunks. Registered so the
// tool list is discoverable from day one; each returns a `not_implemented`
// refusal until its chunk lands. Keeps the `.well-known/mcp.json` list
// stable instead of growing tool-by-tool.
// ---------------------------------------------------------------------------

function notImplemented(tool: McpToolName): CallToolResult {
  return asCallResult(
    {
      ok: false,
      reason: "rate_limited", // nearest-fit in every refusal union
      message: `Tool "${tool}" is registered but not yet implemented. Check the deploy notes.`,
    },
    { isError: true }
  );
}

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Wire every MCP tool handler into an `McpServer`. Called once per request
 * in the stateless Streamable-HTTP transport pattern.
 *
 * We register ALL 8 tools (even the not-yet-implemented ones) so the MCP
 * client's tool discovery list is stable across deploys. Incomplete tools
 * return an `isError: true` refusal.
 */
export function registerMcpTools(server: McpServer): void {
  const handlers: Record<McpToolName, (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult> =
    {
      get_meeting_parameters: (args) =>
        handleGetMeetingParameters(
          args as z.infer<typeof getMeetingParametersInput>
        ),
      get_availability: () => notImplemented("get_availability"),
      get_session_status: () => notImplemented("get_session_status"),
      post_message: () => notImplemented("post_message"),
      propose_parameters: () => notImplemented("propose_parameters"),
      propose_lock: () => notImplemented("propose_lock"),
      cancel_meeting: () => notImplemented("cancel_meeting"),
      reschedule_meeting: () => notImplemented("reschedule_meeting"),
    };

  for (const name of Object.keys(MCP_TOOLS) as McpToolName[]) {
    const tool = MCP_TOOLS[name];
    // `.shape` turns z.object({...}).strict() back into a ZodRawShape the
    // SDK's registerTool accepts directly. `.strict()` is preserved.
    // For unions/primitives at the root we'd need a different path; all
    // 8 tool inputs are object roots (enforced by the smoke tests).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputShape = (tool.input as any).shape as Record<string, any>;
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: inputShape,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handlers[name] as any
    );
  }
}
