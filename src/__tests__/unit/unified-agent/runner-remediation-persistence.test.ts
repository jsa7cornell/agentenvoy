/**
 * Runner — remediation tool-call + result persistence (stream-fixture).
 *
 * Verifies that when self-check flags a turn and the remediation pass runs,
 * the persisted message metadata includes the remediation pass's tool calls
 * AND their full results in a NEW field (`remediationActions` /
 * `remediationActionResults`), scoped separately from the original-stream
 * `actions` / `actionResults`.
 *
 * Motivating triage: cmp50uvuq (2026-05-14). The model hallucinated
 * "tomorrow is May 8, 2026" on a turn where tomorrow was May 14. The
 * `LOAD_calendar_context` call that fed that response happened in the
 * REMEDIATION pass — but only remediation tool *names* (not results) were
 * being persisted, so investigators could not see what the model received.
 * The triage stalled on this observability gap.
 *
 * Variant axis: {remediated: true} × {remediation called write tool,
 * remediation called LOAD only, remediation called no tools (text-only fix)}.
 *
 *   A  remediation calls a write (rule_remove) → both arrays populated,
 *      action+success+message+data shapes intact, original-stream arrays
 *      unaffected
 *   B  remediation calls LOAD only (LOAD_calendar_context) → the cmp50uvuq
 *      shape; arrays populated with the LOAD's result `data` blob preserved
 *   C  remediation makes no tool calls (text-only correction) → fields are
 *      OMITTED from metadata entirely (optional-when-empty, mirroring how
 *      `remediated`/`remediationDurationMs` are conditional)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POST_STREAM_CHECKS } from "@/agent/unified/post-stream-checks";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic import of the SUT.
// ---------------------------------------------------------------------------

const streamTextMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: (...args: unknown[]) => streamTextMock(...args) };
});

// Force self-check to flag — drives the remediation path under test.
vi.mock("@/agent/unified/self-check", () => ({
  runSelfCheck: vi.fn(async () => ({
    passed: false,
    flaggedTools: ["rule_add"],
    reason: "test-flag",
  })),
}));

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

vi.mock("@/lib/model", () => ({
  envoyModel: vi.fn(() => ({})),
}));

vi.mock("@/agent/runtime-prompts", () => ({
  unifiedAgentSystemPrompt: vi.fn(() => "test-system-prompt"),
}));

vi.mock("@/agent/action-narration", () => ({
  narrateFinalizeError: vi.fn(() => "An error occurred."),
}));

vi.mock("@/lib/activity-vocab", () => ({
  emojiForActivity: vi.fn(() => "📅"),
}));

// ---------------------------------------------------------------------------
// SUT — imported AFTER vi.mock declarations.
// ---------------------------------------------------------------------------

import { runUnifiedTurn, type UnifiedTurnConfig } from "@/agent/unified/runner";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

type FixtureToolCall = {
  toolName: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
};

function makeFixture(text: string, toolCalls: FixtureToolCall[] = []) {
  const steps = [
    {
      toolCalls: toolCalls.map((tc) => ({
        toolName: tc.toolName,
        input: tc.input ?? {},
      })),
      toolResults: toolCalls.map((tc) => ({ output: tc.output ?? {} })),
    },
  ];
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text };
    })(),
    steps: Promise.resolve(steps),
    totalUsage: Promise.resolve({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
    }),
  };
}

function makeConfig(opts: {
  emitted: string[];
  persistSpy: (args: { content: string; metadata: unknown; threadId?: string }) => Promise<void>;
}): UnifiedTurnConfig {
  return {
    userId: "u-test",
    userMessage: "Block my Wednesdays",
    timezone: "America/Los_Angeles",
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

type PersistedMetadata = {
  actions?: unknown[];
  actionResults?: unknown[];
  remediationActions?: { action: string; params: Record<string, unknown> }[];
  remediationActionResults?: {
    action: string;
    success: boolean;
    message: string;
    data?: Record<string, unknown>;
  }[];
  unifiedTurn?: { remediated?: boolean; toolCalls?: string[] };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runUnifiedTurn — remediation tool-call + result persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Variant A ────────────────────────────────────────────────────────────
  it("A: remediation calls a write tool → remediationActions/Results populated, original arrays untouched", async () => {
    // Original stream: a flagged write.
    streamTextMock.mockReturnValueOnce(
      makeFixture("Wednesdays blocked.", [
        {
          toolName: "rule_add",
          input: { description: "block wed" },
          output: { success: true, message: "rule added", data: { ruleId: "r1" } },
        },
      ]),
    );
    // Remediation: a corrective write tool.
    streamTextMock.mockReturnValueOnce(
      makeFixture("Done.", [
        {
          toolName: "rule_remove",
          input: { ruleId: "r1" },
          output: { success: true, message: "rule removed", data: { ruleId: "r1" } },
        },
      ]),
    );

    const emitted: string[] = [];
    const persisted: { content: string; metadata: PersistedMetadata }[] = [];
    const persistSpy = vi.fn(async (args: { content: string; metadata: unknown }) => {
      persisted.push({ content: args.content, metadata: args.metadata as PersistedMetadata });
    });

    await runUnifiedTurn(makeConfig({ emitted, persistSpy }));

    expect(persisted).toHaveLength(1);
    const md = persisted[0].metadata;

    // Original-stream arrays carry only the original turn's call.
    expect(md.actions).toEqual([{ action: "rule_add", params: { description: "block wed" } }]);
    expect(md.actionResults).toEqual([
      { action: "rule_add", success: true, message: "rule added", data: { ruleId: "r1" } },
    ]);

    // Remediation arrays carry only the remediation pass's call — separately.
    expect(md.remediationActions).toEqual([
      { action: "rule_remove", params: { ruleId: "r1" } },
    ]);
    expect(md.remediationActionResults).toEqual([
      { action: "rule_remove", success: true, message: "rule removed", data: { ruleId: "r1" } },
    ]);

    // Turn marked as remediated, combined tool-call name list still works.
    expect(md.unifiedTurn?.remediated).toBe(true);
    expect(md.unifiedTurn?.toolCalls).toEqual(["rule_add", "rule_remove"]);
  });

  // ── Variant B ────────────────────────────────────────────────────────────
  it("B: remediation calls LOAD only → result data blob preserved (the cmp50uvuq shape)", async () => {
    // Original stream: a flagged write.
    streamTextMock.mockReturnValueOnce(
      makeFixture("Tomorrow at 9 AM works.", [
        {
          toolName: "rule_add",
          input: { description: "tomorrow" },
          output: { success: true, message: "added", data: {} },
        },
      ]),
    );
    // Remediation: a single LOAD whose result is the load-bearing diagnostic.
    const calendarData = {
      today: "2026-05-14",
      events: [{ id: "e1", start: "2026-05-15T09:00:00-07:00" }],
      timezone: "America/Los_Angeles",
    };
    streamTextMock.mockReturnValueOnce(
      makeFixture("Tomorrow (May 15) at 9 AM is open.", [
        {
          toolName: "LOAD_calendar_context",
          input: { rangeDays: 7 },
          output: { success: true, message: "loaded", data: calendarData },
        },
      ]),
    );

    const emitted: string[] = [];
    const persisted: { content: string; metadata: PersistedMetadata }[] = [];
    const persistSpy = vi.fn(async (args: { content: string; metadata: unknown }) => {
      persisted.push({ content: args.content, metadata: args.metadata as PersistedMetadata });
    });

    await runUnifiedTurn(makeConfig({ emitted, persistSpy }));

    expect(persisted).toHaveLength(1);
    const md = persisted[0].metadata;

    expect(md.remediationActions).toEqual([
      { action: "LOAD_calendar_context", params: { rangeDays: 7 } },
    ]);
    // Critical: the full `data` blob is preserved so future triages can see
    // exactly what the model received during remediation (the cmp50uvuq gap).
    expect(md.remediationActionResults).toEqual([
      {
        action: "LOAD_calendar_context",
        success: true,
        message: "loaded",
        data: calendarData,
      },
    ]);
  });

  // ── Variant C ────────────────────────────────────────────────────────────
  it("C: remediation makes no tool calls (text-only fix) → remediation* fields are omitted", async () => {
    streamTextMock.mockReturnValueOnce(
      makeFixture("Wednesdays blocked.", [
        {
          toolName: "rule_add",
          input: {},
          output: { success: true, message: "added" },
        },
      ]),
    );
    // Remediation: pure text correction, no tools.
    streamTextMock.mockReturnValueOnce(makeFixture("Wednesdays blocked.", []));

    const emitted: string[] = [];
    const persisted: { content: string; metadata: PersistedMetadata }[] = [];
    const persistSpy = vi.fn(async (args: { content: string; metadata: unknown }) => {
      persisted.push({ content: args.content, metadata: args.metadata as PersistedMetadata });
    });

    await runUnifiedTurn(makeConfig({ emitted, persistSpy }));

    expect(persisted).toHaveLength(1);
    const md = persisted[0].metadata;

    // Remediation arrays must not be present when remediation made no calls.
    expect(md.remediationActions).toBeUndefined();
    expect(md.remediationActionResults).toBeUndefined();

    // But the turn is still marked remediated.
    expect(md.unifiedTurn?.remediated).toBe(true);
  });
});
