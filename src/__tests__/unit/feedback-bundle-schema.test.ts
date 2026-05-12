/**
 * FeedbackBundleSchema discriminated-union round-trip tests.
 *
 * Locks:
 *   - v1 bundles (pre-PR) parse cleanly
 *   - v2 bundles parse and emit the exact expected shape
 *   - mixed-version archives don't collide — parser picks the right branch
 *   - guest bundle omits host-only fields (promptContext, recentLinks)
 *   - invalid shapes (wrong version, missing filingContext on v2) fail
 */

import { describe, it, expect } from "vitest";
import {
  FeedbackBundleSchema,
  FeedbackBundleV1Schema,
  FeedbackBundleV2Schema,
  type FeedbackBundleV2,
} from "@/lib/feedback/schema";

const BASE_HEADERS = { url: "https://agentenvoy.ai/x", userAgent: "ua", appVersion: "abc1234" };

const V1_FIXTURE = {
  version: 1 as const,
  capturedAt: "2026-04-21T12:00:00.000Z",
  headers: BASE_HEADERS,
  messages: [{ id: "m1", role: "user", createdAt: "2026-04-21T11:59:00.000Z", content: "hi" }],
};

const FILING_CTX_FIXTURE = {
  filedAt: "2026-04-21T12:00:00.000Z",
  timeSinceLastUserMsg: "23s ago",
  lastAgentOutcome: "action_failed" as const,
  suspectedIncidentTurn: {
    messageId: "m_agent_1",
    outcome: "action_failed",
    userMsg: { id: "m_user_1", content: "confirm please", createdAt: "2026-04-21T11:59:00.000Z" },
    agentMsg: {
      id: "m_agent_1",
      content: "[ACTION confirm_session]",
      createdAt: "2026-04-21T11:59:30.000Z",
      actions: [{ action: "confirm_session", params: { id: "sess_1" } }],
      actionResults: [
        { action: "confirm_session", success: false, message: "no slot selected" },
      ],
    },
  },
  recentFailures: [
    {
      messageId: "m_agent_1",
      action: "confirm_session",
      failureReason: "no slot selected",
      at: "2026-04-21T11:59:30.000Z",
    },
  ],
};

const V2_FIXTURE: FeedbackBundleV2 = {
  version: 2,
  capturedAt: "2026-04-21T12:00:00.000Z",
  headers: BASE_HEADERS,
  filingContext: FILING_CTX_FIXTURE,
  messages: {
    recentTurns: [
      {
        id: "m_user_1",
        role: "user",
        createdAt: "2026-04-21T11:59:00.000Z",
        content: "confirm please",
      },
      {
        id: "m_agent_1",
        role: "envoy",
        createdAt: "2026-04-21T11:59:30.000Z",
        content: "[ACTION confirm_session]",
        actions: [{ action: "confirm_session", params: { id: "sess_1" } }],
        actionResults: [
          { action: "confirm_session", success: false, message: "no slot selected" },
        ],
        promptContext: {
          systemPrompt: "You are Envoy...",
          contextBlock: "Host: testhost",
          modelId: "claude-sonnet-4-6",
        },
      },
    ],
    priorContext: [],
  },
  sessions: [
    {
      id: "sess_1",
      title: "Intro call",
      status: "active",
      agreedTime: null,
      createdAt: "2026-04-21T10:00:00.000Z",
      linkCode: "abc123",
      url: "https://agentenvoy.ai/meet/testhost",
    },
  ],
  recentLinks: [
    {
      code: "abc123",
      slug: "testhost",
      url: "https://agentenvoy.ai/meet/testhost",
      rulesJson: { kind: "primary" },
      createdAt: "2026-04-20T00:00:00.000Z",
      lastEditedAt: "2026-04-21T11:00:00.000Z",
    },
  ],
  clientState: {
    locationHash: "#session-sess_1",
    focusedSessionId: "sess_1",
    viewerTimezone: "America/New_York",
    viewport: { w: 1440, h: 900 },
  },
};

describe("FeedbackBundleV1Schema", () => {
  it("accepts the pre-PR shape", () => {
    expect(FeedbackBundleV1Schema.parse(V1_FIXTURE)).toMatchObject({ version: 1 });
  });
});

describe("FeedbackBundleV2Schema", () => {
  it("accepts the full v2 fixture", () => {
    const parsed = FeedbackBundleV2Schema.parse(V2_FIXTURE);
    expect(parsed.version).toBe(2);
    expect(parsed.filingContext.suspectedIncidentTurn?.agentMsg?.actions?.[0].action).toBe(
      "confirm_session",
    );
    expect(parsed.messages?.recentTurns[1].promptContext?.modelId).toBe("claude-sonnet-4-6");
  });

  it("accepts a guest-shape bundle (sharedChannel instead of messages, no recentLinks)", () => {
    const guestBundle = {
      ...V2_FIXTURE,
      messages: undefined,
      recentLinks: undefined,
      sharedChannel: {
        recentTurns: [
          {
            id: "m_guest_1",
            role: "guest",
            createdAt: "2026-04-21T11:59:00.000Z",
            content: "any slot tomorrow?",
          },
        ],
        priorContext: [],
      },
    };
    expect(() => FeedbackBundleV2Schema.parse(guestBundle)).not.toThrow();
  });

  it("rejects v2 bundles missing filingContext", () => {
    const { filingContext: _drop, ...invalid } = V2_FIXTURE;
    void _drop;
    expect(() => FeedbackBundleV2Schema.parse(invalid)).toThrow();
  });

  it("accepts and round-trips unifiedTurn + moduleGuard metadata on envoy turns", () => {
    // Regression fixture for the Phase 0 fix: prior to this, bundle assembly
    // silently stripped `metadata.unifiedTurn` even though the runner writes it.
    // Report cmp1nni72 surfaced as `metadata: null` purely because of bundle-side
    // projection. This locks the host-bundle pass-through so future schema edits
    // don't regress the debug surface.
    const v2WithUnifiedTurn: FeedbackBundleV2 = {
      ...V2_FIXTURE,
      messages: {
        recentTurns: [
          V2_FIXTURE.messages!.recentTurns[0],
          {
            ...V2_FIXTURE.messages!.recentTurns[1],
            unifiedTurn: {
              model: "claude-sonnet-4-6",
              tier: "default",
              promptVersion: "abc1234",
              toolCalls: ["LOAD_preferences", "rule_add"],
              durationMs: 1842,
              selfCheck: { passed: true },
              cost: {
                inputTokens: 3200,
                outputTokens: 180,
                cacheReadTokens: 2400,
                costUsd: 0.0034,
              },
            },
            moduleGuard: {
              bucket: "rule",
              emittedActions: ["update_availability_rule"],
            },
          },
        ],
        priorContext: V2_FIXTURE.messages!.priorContext,
      },
    };
    const parsed = FeedbackBundleV2Schema.parse(v2WithUnifiedTurn);
    expect(parsed.messages?.recentTurns[1].unifiedTurn?.model).toBe("claude-sonnet-4-6");
    expect(parsed.messages?.recentTurns[1].unifiedTurn?.tier).toBe("default");
    expect(parsed.messages?.recentTurns[1].unifiedTurn?.toolCalls).toEqual([
      "LOAD_preferences",
      "rule_add",
    ]);
    expect(parsed.messages?.recentTurns[1].unifiedTurn?.cost.costUsd).toBe(0.0034);
    expect(parsed.messages?.recentTurns[1].moduleGuard?.bucket).toBe("rule");
  });

  it("rejects unifiedTurn with invalid tier value", () => {
    const invalid = {
      ...V2_FIXTURE,
      messages: {
        recentTurns: [
          V2_FIXTURE.messages!.recentTurns[0],
          {
            ...V2_FIXTURE.messages!.recentTurns[1],
            unifiedTurn: {
              model: "claude-sonnet-4-6",
              tier: "premium", // not in enum
              toolCalls: [],
              durationMs: 100,
              selfCheck: { passed: true },
              cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
            },
          },
        ],
        priorContext: [],
      },
    };
    expect(() => FeedbackBundleV2Schema.parse(invalid)).toThrow();
  });
});

describe("FeedbackBundleSchema discriminated union", () => {
  it("dispatches by version field", () => {
    expect(FeedbackBundleSchema.parse(V1_FIXTURE)).toMatchObject({ version: 1 });
    expect(FeedbackBundleSchema.parse(V2_FIXTURE)).toMatchObject({ version: 2 });
  });

  it("rejects unknown versions", () => {
    expect(() =>
      FeedbackBundleSchema.parse({ ...V1_FIXTURE, version: 3 }),
    ).toThrow();
  });
});
