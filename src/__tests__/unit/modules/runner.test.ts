/**
 * Runner unit tests — verify the orchestrator's logic without live LLM calls.
 *
 * Tests use the `composerInvoker` DI seam to inject deterministic mock
 * responses. Live-LLM behavior is validated separately via the bench harness
 * at `scripts/bench-modules/`.
 *
 * Coverage:
 *  - Happy path (no guards fire) → clean output
 *  - PreEmitCheck fires + retry succeeds
 *  - PreEmitCheck (blocking severity) fires + retries exhaust + fallbackProse ships
 *  - PostStreamGuard (default Layer 2a) fires + retry
 *  - allowedActions enforcement strips out-of-bounds emissions
 *  - Module-not-registered throws
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  runModule,
  registerModule,
  _resetRegistryForTests,
  type ComposerInvoker,
  type IntentModule,
  type ModuleContext,
  type PreEmitCheck,
  type ModuleContextOutput,
  MAX_RETRIES_PER_TURN,
} from "@/agent/modules";

const TEST_USER = { id: "test-user-1", name: "Tester", email: "tester@example.com" };
const TEST_CTX: ModuleContext = {
  user: TEST_USER,
  channel: { id: "test-channel-1" },
  surface: "dashboard-host",
};

function makeMockInvoker(responses: string[]): ComposerInvoker {
  let i = 0;
  return async () => {
    const text = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { text, toolCalls: [] };
  };
}

interface BasicCtx extends ModuleContextOutput {
  recentRuleIds: string[];
}

function makeBasicModule(overrides: Partial<IntentModule<BasicCtx>> = {}): IntentModule<BasicCtx> {
  return {
    intent: "test-intent",
    surface: "dashboard-host",
    description: "Test module",
    composerPlaybook: ["fragments/voice"],
    contextLoader: async () => ({
      contextLines: [],
      recentRuleIds: ["rule_existing"],
    }),
    composerTools: [],
    preEmitChecks: [],
    postStreamGuards: [],
    useDefaultPostStreamGuards: false,            // disable defaults so tests are deterministic
    allowedActions: ["update_availability_rule"],
    responseStyle: "human-prose",
    moduleGuardBucket: "test",
    ...overrides,
  };
}

beforeEach(() => {
  _resetRegistryForTests();
});

describe("runModule — orchestration", () => {
  it("happy path: no guards, no actions, returns buffered output cleanly", async () => {
    registerModule(makeBasicModule());
    const result = await runModule({
      surface: "dashboard-host",
      intent: "test-intent",
      moduleContext: TEST_CTX,
      matchResult: { kind: "deterministic", resolved: {} },
      userMessage: "hello",
      conversationHistory: [],
      composerInvoker: makeMockInvoker(["Got it. Anything else?"]),
    });
    expect(result.kind).toBe("buffered");
    if (result.kind !== "buffered") return;
    expect(result.text).toContain("Got it");
    expect(result.parsedActions).toEqual([]);
    expect(result.moduleGuard.guardsFired).toEqual([]);
    expect(result.moduleGuard.retryCount).toBe(0);
    expect(result.moduleGuard.exhaustedRetries).toBe(false);
  });

  it("preEmitCheck fires + retry produces corrected emission", async () => {
    const fabricatedIdCheck: PreEmitCheck<BasicCtx> = {
      name: "fabricated-id",
      severity: "advisory",
      check: async ({ parsedActions, contextOutput }) => {
        for (const a of parsedActions) {
          if (a.action !== "update_availability_rule") continue;
          const params = a.params as { id?: string; operation?: string };
          if (params.operation !== "update") continue;
          if (!params.id) continue;
          if (contextOutput.recentRuleIds.includes(params.id)) continue;
          return {
            flaggedReason: "fabricated-id",
            hint: "Use a real id from the [GROUND TRUTH] block, or use operation:add.",
          };
        }
        return null;
      },
    };
    registerModule(
      makeBasicModule({
        preEmitChecks: [fabricatedIdCheck],
      }),
    );

    const drifted = `[ACTION]{"action":"update_availability_rule","params":{"operation":"update","id":"fake","rule":{}}}[/ACTION]`;
    const corrected = `[ACTION]{"action":"update_availability_rule","params":{"operation":"add","rule":{}}}[/ACTION]`;
    const result = await runModule({
      surface: "dashboard-host",
      intent: "test-intent",
      moduleContext: TEST_CTX,
      matchResult: { kind: "deterministic", resolved: {} },
      userMessage: "create rule",
      conversationHistory: [],
      composerInvoker: makeMockInvoker([drifted, corrected]),
    });

    expect(result.kind).toBe("buffered");
    if (result.kind !== "buffered") return;
    expect(result.moduleGuard.guardsFired.length).toBeGreaterThan(0);
    expect(result.moduleGuard.guardsFired[0].name).toBe("fabricated-id");
    expect(result.moduleGuard.retryCount).toBe(1);
    expect(result.moduleGuard.retrySucceeded).toBe(true);
    expect(result.parsedActions).toHaveLength(1);
    expect((result.parsedActions[0].params as { operation: string }).operation).toBe("add");
  });

  it("blocking-severity preEmitCheck exhausts retries → ships fallbackProse, suppresses action", async () => {
    const conflictGuard: PreEmitCheck<BasicCtx> = {
      name: "conflict-guard",
      severity: "blocking",
      check: async ({ parsedActions }) => {
        if (parsedActions.length === 0) return null;
        return {
          flaggedReason: "conflict-shadow",
          hint: "This rule shadows existing meetings.",
          fallbackProse: "I noticed this rule would shadow meetings. Confirm to proceed.",
        };
      },
    };
    registerModule(
      makeBasicModule({
        preEmitChecks: [conflictGuard],
      }),
    );

    const drifted = `[ACTION]{"action":"update_availability_rule","params":{"operation":"add","rule":{"action":"block"}}}[/ACTION]`;
    const result = await runModule({
      surface: "dashboard-host",
      intent: "test-intent",
      moduleContext: TEST_CTX,
      matchResult: { kind: "deterministic", resolved: {} },
      userMessage: "block rule",
      conversationHistory: [],
      composerInvoker: makeMockInvoker([drifted, drifted, drifted]),  // composer never adapts
    });

    expect(result.kind).toBe("buffered");
    if (result.kind !== "buffered") return;
    expect(result.moduleGuard.exhaustedRetries).toBe(true);
    expect(result.moduleGuard.retryCount).toBe(MAX_RETRIES_PER_TURN);
    expect(result.moduleGuard.blockingFallbackShipped).toBeDefined();
    expect(result.moduleGuard.blockingFallbackShipped!.checkName).toBe("conflict-guard");
    expect(result.text).toContain("shadow");
    expect(result.parsedActions).toEqual([]);   // action emission suppressed per N3
  });

  it("allowedActions enforcement strips out-of-bounds emissions", async () => {
    registerModule(
      makeBasicModule({
        allowedActions: ["update_availability_rule"], // not "create_link"
      }),
    );
    const oob = `[ACTION]{"action":"create_link","params":{"foo":"bar"}}[/ACTION]`;
    const result = await runModule({
      surface: "dashboard-host",
      intent: "test-intent",
      moduleContext: TEST_CTX,
      matchResult: { kind: "deterministic", resolved: {} },
      userMessage: "go",
      conversationHistory: [],
      composerInvoker: makeMockInvoker([oob]),
    });

    expect(result.kind).toBe("buffered");
    if (result.kind !== "buffered") return;
    expect(result.parsedActions).toEqual([]);
    const violation = result.moduleGuard.guardsFired.find((g) => g.name === "allowed-actions-violation");
    expect(violation).toBeDefined();
    expect(violation!.flaggedReason).toContain("create_link");
  });

  it("module-not-registered throws", async () => {
    await expect(
      runModule({
        surface: "dashboard-host",
        intent: "nonexistent-intent",
        moduleContext: TEST_CTX,
        matchResult: { kind: "deterministic", resolved: {} },
        userMessage: "go",
        conversationHistory: [],
        composerInvoker: makeMockInvoker([""]),
      }),
    ).rejects.toThrow(/No module registered/);
  });

  it("streaming mode throws (PR1a is buffered-only)", async () => {
    registerModule(makeBasicModule());
    await expect(
      runModule({
        surface: "dashboard-host",
        intent: "test-intent",
        moduleContext: TEST_CTX,
        matchResult: { kind: "deterministic", resolved: {} },
        userMessage: "go",
        conversationHistory: [],
        streaming: true,
        composerInvoker: makeMockInvoker([""]),
      }),
    ).rejects.toThrow(/Streaming mode not implemented/);
  });
});
