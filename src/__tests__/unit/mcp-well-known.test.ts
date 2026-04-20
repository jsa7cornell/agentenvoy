/**
 * `.well-known/mcp.json` — smoke test.
 *
 * Asserts the discovery manifest lists every tool in the MCP_TOOLS registry
 * with a JSON Schema derived from the Zod input/output contracts. This is
 * a drift detector: if someone adds a tool to the registry without touching
 * the discovery route, this test fails — keeping the manifest honest is the
 * whole point of deriving it from the registry.
 */
import { describe, it, expect } from "vitest";
import { GET } from "@/app/.well-known/mcp.json/route";
import { MCP_TOOL_NAMES } from "@/lib/mcp/schemas";

describe("GET /.well-known/mcp.json", () => {
  it("lists every registered MCP tool", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      endpoint: string;
      transport: { type: string };
      auth: { type: string; tokenParam: string };
      tools: Array<{
        name: string;
        description: string;
        inputSchema: unknown;
        outputSchema: unknown;
      }>;
    };

    expect(json.transport.type).toBe("streamable-http");
    expect(json.auth.type).toBe("url-capability");
    expect(json.auth.tokenParam).toBe("meetingUrl");
    expect(json.endpoint).toMatch(/\/api\/mcp$/);

    const manifestNames = json.tools.map((t) => t.name).sort();
    const registryNames = [...MCP_TOOL_NAMES].sort();
    expect(manifestNames).toEqual(registryNames);

    // Every tool's input schema should be an object — the SDK rejects
    // non-object roots, and `.well-known` clients will trip on the same
    // rules. Cheap drift guard.
    for (const t of json.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      const input = t.inputSchema as { type?: string; properties?: unknown };
      expect(input.type).toBe("object");
    }
  });

  it("sets a public cache-control header", () => {
    const res = GET();
    const cc = res.headers.get("cache-control");
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age/);
  });
});
