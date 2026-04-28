/**
 * Unit tests for the role-aware classifier plumbing introduced in Phase 5
 * PR 4. Mocks `ai`, `@/lib/model`, and `@/lib/langfuse` so no real LLM call
 * fires — the assertions live entirely on what the classifier passes
 * through to `generateObject` and what it returns for each role.
 *
 * Behavior axes covered:
 *   - default role is `guest` (preserves byte-identical behavior at the
 *     existing `chat/route.ts:304` call site)
 *   - explicit `role: "guest"` retains the fabrication / closed-set
 *     clarifier path
 *   - explicit `role: "host"` loads the host playbook + accepts each of
 *     the 5 host enum values
 *   - host path skips fabrication detection (no `unclear` tier)
 *   - retry fallback is role-aware: `schedule` for guest, `chat` for host
 *   - `role` lands on the `recordSpan` metadata as a telemetry slot
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.fn();
const recordSpanMock = vi.fn(async (...args: unknown[]) => {
  // Mocked recordSpan: invoke the wrapped fn and return its result so the
  // outer classifier sees the same shape as a no-op span. Args are
  // captured via `mock.calls` for assertion.
  const fn = args[1] as () => Promise<unknown>;
  return fn();
});

vi.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
}));

vi.mock("@/lib/model", () => ({
  envoyModel: (modelId: string) => ({ id: modelId }),
}));

vi.mock("@/lib/langfuse", () => ({
  recordSpan: (...args: unknown[]) => recordSpanMock(...args),
}));

import { classifyChatIntent } from "@/agent/intent-classifier";

describe("classifyChatIntent — role plumbing", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    recordSpanMock.mockClear();
    recordSpanMock.mockImplementation(async (...args: unknown[]) => {
      const fn = args[1] as () => Promise<unknown>;
      return fn();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults role to guest and accepts a guest schedule value", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { kind: "schedule" } });

    const result = await classifyChatIntent("Book Bob tomorrow at 2pm");

    expect(result.intent.kind).toBe("schedule");
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const sentArgs = generateObjectMock.mock.calls[0][0] as { system: string };
    // PR2: guest classifier (intent-classifier.md) deleted. Guest path now
    // passes an empty system prompt — the LLM call still fires and the
    // result is validated normally. Host playbook must not be loaded.
    expect(sentArgs.system).not.toContain("# Host chat intent classifier");
  });

  it("explicit role:guest preserves the fabrication / closed-set fallback path", async () => {
    // Haiku returns `unclear` with no clarifier — server-side substitution
    // should kick in and the validated block must keep `kind: "unclear"`
    // with one of the closed-set strings (not the schedule fallback).
    generateObjectMock.mockResolvedValueOnce({ object: { kind: "unclear" } });

    const result = await classifyChatIntent(
      "do the thing",
      { activeSessionsSummary: "- Untitled (guest: Bob)" },
      "guest",
    );

    expect(result.intent.kind).toBe("unclear");
    expect(typeof result.intent.clarifier).toBe("string");
    expect(result.intent.clarifier!.length).toBeGreaterThan(0);
    expect(result.fabricationDetected).toBe(true);
  });

  it("role:host loads the host playbook (not the guest one)", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { kind: "chat" } });

    await classifyChatIntent("hey!", {}, "host");

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const sentArgs = generateObjectMock.mock.calls[0][0] as { system: string };
    expect(sentArgs.system).toContain("# Host chat intent classifier");
    expect(sentArgs.system).not.toContain("# Chat intent classifier\n\nYou classify the host's turn-level intent into one of six tiers.");
  });

  it("role:host accepts each of the 7 host intents and returns matching block", async () => {
    // PR1 (chat-decisioning-layer-redesign) split create_link → create_link /
    // modify_link / cancel_link; the schema now has 7 closed values.
    const hostIntents = [
      "edit_preference",
      "create_link",
      "modify_link",
      "cancel_link",
      "query_calendar",
      "query_event",
      "chat",
    ] as const;

    for (const kind of hostIntents) {
      generateObjectMock.mockResolvedValueOnce({ object: { kind } });
      const result = await classifyChatIntent("test", {}, "host");
      expect(result.intent).toEqual({ kind });
      expect(result.rawKind).toBe(kind);
    }
  });

  // -------------------------------------------------------------------------
  // PR1 — modify_link / cancel_link discrimination (proposal §10 Bug #2/#3).
  // The Haiku layer is the one that decides between create / modify / cancel
  // based on the verb. Here we mock the Haiku response and verify the
  // classifier returns the value verbatim — no silent reshaping.
  // -------------------------------------------------------------------------

  it("role:host returns modify_link verbatim when Haiku emits it", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { kind: "modify_link" },
    });

    const result = await classifyChatIntent(
      "shift the bike ride to Friday",
      {},
      "host",
    );

    expect(result.intent).toEqual({ kind: "modify_link" });
    expect(result.rawKind).toBe("modify_link");
    expect(result.fabricationDetected).toBe(false);
  });

  it("role:host returns cancel_link verbatim when Haiku emits it", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { kind: "cancel_link" },
    });

    const result = await classifyChatIntent(
      "cancel my Sarah link",
      {},
      "host",
    );

    expect(result.intent).toEqual({ kind: "cancel_link" });
    expect(result.rawKind).toBe("cancel_link");
    expect(result.fabricationDetected).toBe(false);
  });

  it("role:host returns chat for display-settings turns (Bug #2 — 'change to light mode')", async () => {
    // Pre-PR1 the host classifier (operating on the guest schema) emitted
    // `schedule` here because "change" looked schedule-shaped to a
    // create-only enum. With the host-side enum + per-intent playbook, the
    // composer instructs Haiku to emit `chat` for app-chrome requests.
    generateObjectMock.mockResolvedValueOnce({ object: { kind: "chat" } });

    const result = await classifyChatIntent(
      "change to light mode",
      {},
      "host",
    );

    expect(result.intent.kind).toBe("chat");
    expect(result.intent.clarifier).toBeUndefined();
    expect(result.fabricationDetected).toBe(false);
  });

  it("role:host skips fabrication detection (no clarifier set when LLM returns chat)", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { kind: "chat" } });

    const result = await classifyChatIntent(
      "hey!",
      {
        // priorEnvoyTurn would push pickClosedSetClarifier toward a default-style
        // string for guest path; on host path it must be ignored entirely.
        priorEnvoyTurn: "Want me to update your default duration?",
        activeSessionsSummary: "- Untitled (guest: Bob)",
      },
      "host",
    );

    expect(result.intent.kind).toBe("chat");
    // Host path must NOT graft a clarifier onto host-side blocks.
    expect(result.intent.clarifier).toBeUndefined();
    expect(result.fabricationDetected).toBe(false);
  });

  it("role:host retry fallback returns { kind: 'chat' } on two failures", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("network err"));
    generateObjectMock.mockRejectedValueOnce(new Error("network err 2"));

    const result = await classifyChatIntent("test", {}, "host");

    expect(result.intent).toEqual({ kind: "chat" });
    expect(result.retried).toBe(true);
    expect(result.rawKind).toBeNull();
    expect(result.fabricationDetected).toBe(false);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it("role:guest retry fallback returns { kind: 'schedule' } on two failures (existing)", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("network err"));
    generateObjectMock.mockRejectedValueOnce(new Error("network err 2"));

    const result = await classifyChatIntent("test", {}, "guest");

    expect(result.intent).toEqual({ kind: "schedule" });
    expect(result.retried).toBe(true);
    expect(result.rawKind).toBeNull();
    expect(result.fabricationDetected).toBe(false);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it("recordSpan metadata carries the role telemetry slot (host)", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { kind: "chat" } });

    await classifyChatIntent("hey!", {}, "host");

    expect(recordSpanMock).toHaveBeenCalledTimes(1);
    const metadata = recordSpanMock.mock.calls[0][2] as Record<string, unknown>;
    expect(metadata.role).toBe("host");
  });

  it("recordSpan metadata carries the role telemetry slot (guest, default)", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { kind: "schedule" } });

    await classifyChatIntent("Book Bob tomorrow");

    expect(recordSpanMock).toHaveBeenCalledTimes(1);
    const metadata = recordSpanMock.mock.calls[0][2] as Record<string, unknown>;
    expect(metadata.role).toBe("guest");
  });

  it("role:host validates a malformed object via validateChatIntent's default branch", async () => {
    // If the host path were skipping validation entirely, an unknown kind
    // would slip through. validateChatIntent must coerce it to unclear+generic.
    generateObjectMock.mockResolvedValueOnce({ object: { kind: "totally_made_up" } });

    const result = await classifyChatIntent("garbage", {}, "host");

    // validateChatIntent maps unknown kinds → unclear + generic clarifier.
    expect(result.intent.kind).toBe("unclear");
    expect(typeof result.intent.clarifier).toBe("string");
    expect(result.rawKind).toBe("totally_made_up");
  });
});
