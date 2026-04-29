/**
 * Internal tool registry for the agent runner.
 *
 * This is the host-side surface for tools that internal Sonnet composers
 * can call within a single chat turn. Different from the *external* MCP
 * surface at `src/lib/mcp/tools.ts` — that one serves outside agents over
 * the wire; this one composes tools into the AI SDK's `streamText`/
 * `generateText` call so Sonnet can invoke them mid-turn and ground its
 * response in the result.
 *
 * Background: 2026-04-29 bilateral+picker bundle, PR-0a (foundational).
 * The registry is empty in this PR — it's plumbing only. PR-A2 of the
 * bundle will register `get_matched_availability` against this registry
 * for the deal-room guest composer path.
 *
 * Usage pattern:
 *   import { type ToolRegistry } from "@/agent/tools/registry";
 *   const tools: ToolRegistry = {
 *     my_tool: tool({ description, inputSchema, execute }),
 *   };
 *   await streamAgentResponse(context, { tools, ... });
 *
 * Privacy / scope discipline (load-bearing for the bundle):
 *   - Tools are scoped per-call. The agent runner doesn't carry an
 *     ambient registry — every call site decides which tools (if any)
 *     the model can see.
 *   - Tools registered for the deal-room guest path MUST NOT be silently
 *     reused on the host-side dashboard chat or the greeting path. Each
 *     surface explicitly opts in.
 *   - External MCP consumers (mcp/tools.ts) never see this registry. The
 *     two surfaces stay type-disjoint.
 */
import type { ToolSet } from "ai";

/**
 * Type alias kept thin so call sites can ship their own ToolSet without
 * any registry machinery getting in the way. The "registry" framing is
 * conceptual — there's no central state, just a shared type contract.
 */
export type ToolRegistry = ToolSet;
