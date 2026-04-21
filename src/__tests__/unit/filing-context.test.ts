/**
 * buildFilingContext + computeRecentTurnsCount heuristic tests.
 *
 * The three-step fallback (failure → within-10-min → last agent turn) is
 * load-bearing — breaks here silently degrade agent debugging quality.
 */

import { describe, it, expect } from "vitest";
import {
  buildFilingContext,
  computeRecentTurnsCount,
  type FilingMessage,
} from "@/lib/feedback/build-filing-context";

function msg(
  overrides: Partial<FilingMessage> & { id: string; role: string; at: string; content?: string },
): FilingMessage {
  return {
    id: overrides.id,
    role: overrides.role,
    content: overrides.content ?? "",
    createdAt: new Date(overrides.at),
    metadata: overrides.metadata ?? null,
  };
}

const FILED_AT = new Date("2026-04-21T12:00:00Z");
const within = (offsetSec: number) =>
  new Date(FILED_AT.getTime() - offsetSec * 1000).toISOString();

describe("buildFilingContext heuristic", () => {
  it("Step 1: picks the most recent agent turn with a failed actionResult", () => {
    const messages: FilingMessage[] = [
      msg({ id: "u1", role: "user", at: within(3600), content: "book it" }),
      msg({
        id: "a1",
        role: "envoy",
        at: within(3599),
        content: "[ACTION create_link]",
        metadata: {
          actions: [{ action: "create_link", params: {} }],
          actionResults: [{ action: "create_link", success: false, message: "rules invalid" }],
        },
      }),
      msg({ id: "u2", role: "user", at: within(600), content: "ok actually reschedule" }),
      msg({
        id: "a2",
        role: "envoy",
        at: within(599),
        content: "done",
        metadata: {
          actions: [{ action: "reschedule", params: {} }],
          actionResults: [{ action: "reschedule", success: true, message: "ok" }],
        },
      }),
    ];
    const ctx = buildFilingContext(messages, FILED_AT);
    expect(ctx.suspectedIncidentTurn?.messageId).toBe("a1");
    expect(ctx.suspectedIncidentTurn?.outcome).toBe("action_failed");
    expect(ctx.suspectedIncidentTurn?.userMsg?.id).toBe("u1");
    expect(ctx.recentFailures).toHaveLength(1);
    expect(ctx.recentFailures[0].action).toBe("create_link");
    // lastAgentOutcome summarises the last agent turn (a2 = success), NOT the incident pick.
    expect(ctx.lastAgentOutcome).toBe("success");
  });

  it("Step 2: no failures → picks most recent agent turn within 10 min window", () => {
    const messages: FilingMessage[] = [
      msg({ id: "u_old", role: "user", at: within(86400), content: "old msg" }),
      msg({
        id: "a_old",
        role: "envoy",
        at: within(86400 - 30),
        content: "reply",
        metadata: { actions: [{ action: "noop", params: {} }], actionResults: [{ action: "noop", success: true, message: "ok" }] },
      }),
      msg({ id: "u_recent", role: "user", at: within(60), content: "broke" }),
      msg({
        id: "a_recent",
        role: "envoy",
        at: within(30),
        content: "",
        metadata: null,
      }),
    ];
    const ctx = buildFilingContext(messages, FILED_AT);
    expect(ctx.suspectedIncidentTurn?.messageId).toBe("a_recent");
  });

  it("Step 3: no failures and no recent → falls back to last agent turn", () => {
    const messages: FilingMessage[] = [
      msg({ id: "u", role: "user", at: within(86400) }),
      msg({ id: "a", role: "envoy", at: within(86399), content: "replied long ago" }),
    ];
    const ctx = buildFilingContext(messages, FILED_AT);
    expect(ctx.suspectedIncidentTurn?.messageId).toBe("a");
    expect(ctx.suspectedIncidentTurn?.outcome).toBe("no_action");
  });

  it("returns null suspectedIncidentTurn when there are no agent messages", () => {
    const messages: FilingMessage[] = [
      msg({ id: "u", role: "user", at: within(30), content: "hello" }),
    ];
    const ctx = buildFilingContext(messages, FILED_AT);
    expect(ctx.suspectedIncidentTurn).toBeNull();
    expect(ctx.lastAgentOutcome).toBe("no_action");
  });

  it("timeSinceLastUserMsg is a human-readable short string", () => {
    const messages: FilingMessage[] = [
      msg({ id: "u", role: "user", at: within(23), content: "hi" }),
    ];
    const ctx = buildFilingContext(messages, FILED_AT);
    expect(ctx.timeSinceLastUserMsg).toBe("23s ago");
  });
});

describe("computeRecentTurnsCount", () => {
  const ordered = Array.from({ length: 30 }, (_, i) =>
    msg({ id: `m${i}`, role: i % 2 === 0 ? "user" : "envoy", at: within(30 - i) }),
  );

  it("returns the baseline (10) when incident is in the tail", () => {
    expect(computeRecentTurnsCount(30, "m29", ordered)).toBe(10);
    expect(computeRecentTurnsCount(30, "m21", ordered)).toBe(10);
  });

  it("extends beyond baseline to cover the incident turn", () => {
    // m5 is 25 from end → must return 25
    expect(computeRecentTurnsCount(30, "m5", ordered)).toBe(25);
  });

  it("clamps to totalMessages when incidentId is missing", () => {
    expect(computeRecentTurnsCount(3, null, ordered.slice(0, 3))).toBe(3);
    expect(computeRecentTurnsCount(50, "nonexistent", ordered)).toBe(10);
  });
});
