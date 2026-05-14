/**
 * Runner — narration-leak truncation (stream-fixture).
 *
 * Verifies that `runUnifiedTurn` applies `narrationLeakCheck`'s
 * `replaceFullText` to both the persisted content and the final emitted text
 * frame. Uses a fixture-injected stream instead of a real model call so every
 * variant is deterministic.
 *
 * Variant axis: {forbidden-phrase-detected} × {clean-remainder, all-leaked, no-write}
 *
 *   A  preamble + clean closing  → stripped to clean closing
 *   B  all-reasoning + write succeeded → fallback canonical sentence
 *   C  all-reasoning + no write succeeded → empty replacement (silent bubble)
 *   D  clean prose → no replacement applied; text passes through unchanged
 *
 * Fix commit: 66f1db7  (narration-leak truncation + extended thinking off)
 * Proposal: proposals/2026-05-12_unified-agent-cost-recency-thinking-load-and-theater-defense_...
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POST_STREAM_CHECKS } from "@/agent/unified/post-stream-checks";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic import of the SUT.
// ---------------------------------------------------------------------------

/** Captures the fake streamText call; tests configure with .mockReturnValueOnce */
const streamTextMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
  // Keep the real module (stepCountIs, type helpers, etc.); replace only streamText.
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: (...args: unknown[]) => streamTextMock(...args) };
});

// Self-check always passes — remediation path is not under test here.
vi.mock("@/agent/unified/self-check", () => ({
  runSelfCheck: vi.fn(async () => ({ passed: true })),
}));

// Deterministic model-policy — tier/cost values don't affect narration-leak logic.
vi.mock("@/agent/unified/model-policy", () => ({
  selectModelForTurn: vi.fn(() => ({
    tier: "standard",
    modelId: "claude-sonnet-4-5-20251101",
    reason: "test",
  })),
  computeTurnCost: vi.fn(() => ({
    model: "claude-sonnet-4-5-20251101",
    tier: "standard",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
  })),
}));

// envoyModel — only needs to be callable; result is ignored by mocked streamText.
vi.mock("@/lib/model", () => ({
  envoyModel: vi.fn(() => ({})),
}));

// Module-level SYSTEM_PROMPT init in runner.ts — provide a stub.
vi.mock("@/agent/runtime-prompts", () => ({
  unifiedAgentSystemPrompt: vi.fn(() => "test-system-prompt"),
}));

// narrateFinalizeError — only called on stream errors.
vi.mock("@/agent/action-narration", () => ({
  narrateFinalizeError: vi.fn(() => "An error occurred."),
}));

// emojiForActivity — called by link-card extraction helper on every tool-call step.
vi.mock("@/lib/activity-vocab", () => ({
  emojiForActivity: vi.fn(() => "📅"),
}));

// ---------------------------------------------------------------------------
// SUT — imported AFTER vi.mock declarations so mocks are in place.
// ---------------------------------------------------------------------------

import { runUnifiedTurn, type UnifiedTurnConfig } from "@/agent/unified/runner";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

type FixtureTool = { toolName: string; success: boolean | undefined };

/**
 * Returns a fake `streamText` result:
 *   - `fullStream`: async iterable yielding a single text-delta chunk
 *   - `steps`: one step with the given tool calls + synthetic results
 *   - `totalUsage`: stub token counts
 *
 * `success: undefined` → tool result output has no `success` key
 * (mimics LOAD_* tools that return raw data without a success flag).
 */
function makeFixture(text: string, toolCalls: FixtureTool[] = []) {
  const steps = [
    {
      toolCalls: toolCalls.map((tc) => ({ toolName: tc.toolName, input: {} })),
      toolResults: toolCalls.map((tc) => ({
        output: tc.success !== undefined ? { success: tc.success } : {},
      })),
    },
  ];
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text };
    })(),
    steps: Promise.resolve(steps),
    totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }),
  };
}

/** Parse NDJSON frames emitted by the runner; return the last "text" frame's content. */
function lastTextContent(frames: string[]): string | undefined {
  let last: string | undefined;
  for (const raw of frames) {
    try {
      const parsed = JSON.parse(raw) as { type: string; content?: string };
      if (parsed.type === "text" && parsed.content !== undefined) {
        last = parsed.content;
      }
    } catch {
      /* non-JSON frames (shouldn't happen in tests) */
    }
  }
  return last;
}

/** Build a minimal UnifiedTurnConfig with an injectable enqueue + persistEnvoyMessage. */
function makeConfig(opts: {
  emitted: string[];
  persistSpy: (args: { content: string; metadata: unknown; threadId?: string }) => Promise<void>;
}): UnifiedTurnConfig {
  return {
    userId: "u-test",
    userMessage: "Block my Wednesdays",
    systemPrompt: "test-system-prompt",
    tools: {},
    recentMessages: [],
    priorToolUseInHistory: false,
    priorEnvoyTurnCount: 2,
    postStreamChecks: DEFAULT_POST_STREAM_CHECKS,
    enqueue: (chunk) => opts.emitted.push(chunk),
    persistEnvoyMessage: opts.persistSpy,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runUnifiedTurn — narration-leak truncation (stream-fixture)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Variant A ──────────────────────────────────────────────────────────────
  it("A: strips forbidden-phrase preamble, keeps clean closing sentence", async () => {
    const leakedText =
      "Now I'll load the calendar to check your schedule. " +
      "Looking at your calendar for available blocks. " +
      "Wednesdays blocked.";

    streamTextMock.mockReturnValueOnce(
      makeFixture(leakedText, [{ toolName: "rule_add", success: true }]),
    );

    const emitted: string[] = [];
    const persisted: { content: string; metadata: unknown }[] = [];
    const persistSpy = vi.fn(async (args: { content: string; metadata: unknown }) => {
      persisted.push(args);
    });

    await runUnifiedTurn(makeConfig({ emitted, persistSpy }));

    const expectedClean = "Wednesdays blocked.";

    // Persisted content must be the stripped version, not the raw leak.
    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toBe(expectedClean);

    // Final text frame must also carry the stripped version.
    expect(lastTextContent(emitted)).toBe(expectedClean);
  });

  // ── Variant B ──────────────────────────────────────────────────────────────
  it("B: all sentences are reasoning-preamble + write succeeded → fallback canonical", async () => {
    // Every sentence matches a forbidden-phrase pattern; none survive stripping.
    const allLeaked =
      "Now I'll load the calendar to find availability. " +
      "Let me check the preferences before deciding. " +
      "I need to verify the existing rules.";

    streamTextMock.mockReturnValueOnce(
      makeFixture(allLeaked, [{ toolName: "rule_add", success: true }]),
    );

    const emitted: string[] = [];
    const persisted: { content: string; metadata: unknown }[] = [];
    const persistSpy = vi.fn(async (args: { content: string; metadata: unknown }) => {
      persisted.push(args);
    });

    await runUnifiedTurn(makeConfig({ emitted, persistSpy }));

    const expectedFallback = "Done. Let me know if you want to adjust.";

    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toBe(expectedFallback);
    expect(lastTextContent(emitted)).toBe(expectedFallback);
  });

  // ── Variant C ──────────────────────────────────────────────────────────────
  it("C: all sentences are reasoning-preamble + no write succeeded → empty replacement", async () => {
    const allLeaked =
      "Now I'll load the calendar to find availability. " +
      "Let me check the preferences before deciding.";

    // No tool calls → anyWriteSuccess = false → replacement = ""
    streamTextMock.mockReturnValueOnce(makeFixture(allLeaked, []));

    const emitted: string[] = [];
    const persisted: { content: string; metadata: unknown }[] = [];
    const persistSpy = vi.fn(async (args: { content: string; metadata: unknown }) => {
      persisted.push(args);
    });

    await runUnifiedTurn(makeConfig({ emitted, persistSpy }));

    // Empty replacement: persisted content is "" and final text frame is "".
    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toBe("");
    expect(lastTextContent(emitted)).toBe("");
  });

  // ── Variant D ──────────────────────────────────────────────────────────────
  it("D: clean prose with no forbidden phrases passes through unchanged", async () => {
    const cleanText = "Wednesdays are now blocked — 9 AM to 5 PM.";

    streamTextMock.mockReturnValueOnce(
      makeFixture(cleanText, [{ toolName: "rule_add", success: true }]),
    );

    const emitted: string[] = [];
    const persisted: { content: string; metadata: unknown }[] = [];
    const persistSpy = vi.fn(async (args: { content: string; metadata: unknown }) => {
      persisted.push(args);
    });

    await runUnifiedTurn(makeConfig({ emitted, persistSpy }));

    // No leak detected → no replacement → original text preserved.
    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toBe(cleanText);
    expect(lastTextContent(emitted)).toBe(cleanText);
  });
});
