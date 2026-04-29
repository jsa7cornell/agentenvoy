import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "ai";
import { z } from "zod";

// Mock the model layer so tests don't reach for real API credentials.
vi.mock("@/lib/model", () => ({
  envoyModel: () => "mock-model" as unknown,
}));

// Mock composer dependencies — agent-runner.ts pulls these in for prompt
// assembly, but the streamText call itself is what we're testing.
vi.mock("@/agent/composer", () => ({
  composeSystemPrompt: () => "fixture-system-prompt",
  getModelForDomain: () => "claude-sonnet-4-6",
}));

// Capture the args streamText is called with so we can assert the tool
// plumbing landed cleanly.
const streamTextSpy = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (args: unknown) => {
      streamTextSpy(args);
      // Return a fixture result with a .text + .steps so onFinish can fire
      // through the agent-runner's wrapping layer.
      return {
        text: Promise.resolve(""),
      };
    },
  };
});

// Imported lazily inside tests via dynamic import — top-level await is
// disallowed under this project's TS module target.
let streamAgentResponse: typeof import("@/agent/agent-runner").streamAgentResponse;

beforeEach(async () => {
  streamTextSpy.mockClear();
  ({ streamAgentResponse } = await import("@/agent/agent-runner"));
});

describe("streamAgentResponse — tool plumbing (PR-0a)", () => {
  const baseContext = {
    role: "coordinator" as const,
    hostName: "Test Host",
    conversationHistory: [{ role: "user", content: "hello" }],
  };

  it("does NOT pass `tools` or `stopWhen` when tools option is omitted", async () => {
    await streamAgentResponse(baseContext);

    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    const args = streamTextSpy.mock.calls[0][0];

    // No-tools path must keep the pre-PR-0a call shape — no `tools`, no
    // `stopWhen`. This is the default for every existing caller (greeting
    // path, dashboard chat, etc.) so behavior change is gated on opt-in.
    expect(args.tools).toBeUndefined();
    expect(args.stopWhen).toBeUndefined();
  });

  it("does NOT pass `tools` when an empty registry is provided", async () => {
    await streamAgentResponse(baseContext, { tools: {} });

    const args = streamTextSpy.mock.calls[0][0];
    // Defensive: `tools: {}` is a valid empty registry but threading it to
    // streamText is wasteful and would set up step counters unnecessarily.
    expect(args.tools).toBeUndefined();
    expect(args.stopWhen).toBeUndefined();
  });

  it("threads `tools` and `stopWhen` to streamText when a non-empty registry is provided", async () => {
    const fixtureTool = tool({
      description: "fixture tool for the test",
      inputSchema: z.object({ foo: z.string() }),
      execute: async () => ({ ok: true }),
    });

    await streamAgentResponse(baseContext, {
      tools: { fixture_tool: fixtureTool },
    });

    const args = streamTextSpy.mock.calls[0][0];
    expect(args.tools).toBeDefined();
    expect(args.tools).toHaveProperty("fixture_tool");
    expect(args.stopWhen).toBeDefined();
  });

  it("passes the system prompt and message history through unchanged", async () => {
    await streamAgentResponse({
      ...baseContext,
      conversationHistory: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    });

    const args = streamTextSpy.mock.calls[0][0];
    expect(args.system).toBe("fixture-system-prompt");
    expect(args.messages).toHaveLength(3);
    expect(args.messages[0]).toEqual({ role: "user", content: "first" });
    expect(args.messages[2]).toEqual({ role: "user", content: "second" });
  });

  it("invokes onInvocation with the system prompt and modelId before streamText kicks off", async () => {
    const onInvocation = vi.fn();
    await streamAgentResponse(baseContext, { onInvocation });

    expect(onInvocation).toHaveBeenCalledTimes(1);
    expect(onInvocation).toHaveBeenCalledWith({
      systemPrompt: "fixture-system-prompt",
      modelId: "claude-sonnet-4-6",
    });
  });
});
