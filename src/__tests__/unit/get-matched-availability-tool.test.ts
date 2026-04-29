import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCompute = vi.fn();
vi.mock("@/lib/bilateral-availability", () => ({
  computeBilateralForSession: (...args: unknown[]) => mockCompute(...args),
}));

let buildGetMatchedAvailabilityTool: typeof import("@/agent/tools/get-matched-availability").buildGetMatchedAvailabilityTool;

beforeEach(async () => {
  mockCompute.mockReset();
  ({ buildGetMatchedAvailabilityTool } = await import(
    "@/agent/tools/get-matched-availability"
  ));
});

describe("buildGetMatchedAvailabilityTool — Cut 2 privacy gate", () => {
  it("ALWAYS passes includeConflicts: false to computeBilateralForSession", async () => {
    mockCompute.mockResolvedValueOnce({
      available: true,
      hostFirstName: "John",
      byDay: [],
    });
    const tool = buildGetMatchedAvailabilityTool("session-1");
    // Tool shape from AI SDK's `tool()` helper — we exercise execute directly.
    const execute = (tool as unknown as {
      execute: (input: unknown, opts?: unknown) => Promise<unknown>;
    }).execute;
    await execute({}, {});
    expect(mockCompute).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ includeConflicts: false }),
    );
  });

  it("never permits an input that flips includeConflicts to true", () => {
    // Cut 2 invariant: the tool's input schema must not accept includeConflicts.
    // If a future commit adds it as an input field, this test fails.
    const tool = buildGetMatchedAvailabilityTool("session-1");
    const schema = (tool as unknown as { inputSchema: { _def?: unknown } })
      .inputSchema;
    // Zod schema introspection — if `includeConflicts` is a key, this finds it.
    const stringified = JSON.stringify(schema);
    expect(stringified).not.toContain("includeConflicts");
  });

  it("threads optional dateRange through to compute", async () => {
    mockCompute.mockResolvedValueOnce({
      available: true,
      hostFirstName: "John",
      byDay: [],
    });
    const tool = buildGetMatchedAvailabilityTool("session-1");
    const execute = (tool as unknown as {
      execute: (input: unknown, opts?: unknown) => Promise<unknown>;
    }).execute;
    await execute(
      { dateRange: { start: "2026-05-01", end: "2026-05-07" } },
      {},
    );
    expect(mockCompute).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        dateRange: { start: "2026-05-01", end: "2026-05-07" },
        includeConflicts: false,
      }),
    );
  });

  it("baked sessionId is per-call — separate tool instances don't share state", async () => {
    mockCompute.mockResolvedValue({
      available: true,
      hostFirstName: "John",
      byDay: [],
    });
    const a = buildGetMatchedAvailabilityTool("session-A");
    const b = buildGetMatchedAvailabilityTool("session-B");
    const exec = (t: unknown) =>
      (t as { execute: (input: unknown, opts?: unknown) => Promise<unknown> }).execute(
        {},
        {},
      );
    await exec(a);
    await exec(b);
    expect(mockCompute).toHaveBeenNthCalledWith(1, "session-A", expect.anything());
    expect(mockCompute).toHaveBeenNthCalledWith(2, "session-B", expect.anything());
  });

  it("propagates the canonical BilateralPayload through execute unchanged", async () => {
    const fixture = {
      available: true,
      hostFirstName: "John",
      byDay: [
        {
          date: "2026-04-29",
          matched: [
            {
              start: "2026-04-29T16:00:00.000Z",
              end: "2026-04-29T16:30:00.000Z",
              hostLabel: "9 AM PT",
            },
          ],
          looseMutual: [],
          conflicts: [],
          hasHostHours: true,
        },
      ],
    };
    mockCompute.mockResolvedValueOnce(fixture);
    const tool = buildGetMatchedAvailabilityTool("session-1");
    const execute = (tool as unknown as {
      execute: (input: unknown, opts?: unknown) => Promise<unknown>;
    }).execute;
    const result = await execute({}, {});
    expect(result).toEqual(fixture);
  });
});

describe("get_matched_availability tool — playbook alignment", () => {
  // The playbook references specific behaviors that the tool must support
  // for the LLM's instructions to remain truthful. If the playbook drifts
  // from what the tool actually does, the LLM will produce confused output.
  // These tests assert the tool's description and playbook copy stay aligned.

  it("tool description names the privacy properties the playbook relies on", () => {
    const tool = buildGetMatchedAvailabilityTool("session-1");
    const description = (tool as unknown as { description: string })
      .description;
    // Playbook copy promises the LLM these properties; description must
    // mention each so the LLM has the same model.
    expect(description).toContain("matched");
    expect(description).toContain("looseMutual");
    expect(description).toContain("hasHostHours");
    expect(description).toContain("hostFirstName");
  });

  it("tool description encodes the negative rule (don't call on agreement turns)", () => {
    const tool = buildGetMatchedAvailabilityTool("session-1");
    const description = (tool as unknown as { description: string })
      .description;
    expect(description.toLowerCase()).toContain("when not to call");
  });

  it("tool description encodes the available:false fallback rule", () => {
    const tool = buildGetMatchedAvailabilityTool("session-1");
    const description = (tool as unknown as { description: string })
      .description;
    expect(description).toContain("available: false");
    expect(description).toContain("OFFERABLE SLOTS");
  });
});
