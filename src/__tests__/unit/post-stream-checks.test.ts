/**
 * Phase A.5 + B3-c convergence — post-stream-checks tests.
 *
 * Locks in:
 *   - `narrationWithoutEmitCheck` fires on confirmation prose with zero tools.
 *   - `successTheaterCheck` fires when at least one tool returned success: false
 *     AND prose looks confirmation-shaped.
 *   - The two partition the failure space — `narrationWithoutEmitCheck`
 *     never fires when any tool was called; `successTheaterCheck` never fires
 *     when toolCalls is empty.
 *   - Read-only prose ("Your timezone is America/...") doesn't trip either gate.
 *   - cmp1nni72-shape input fires `narrationWithoutEmitCheck` exactly.
 *   - The five confirmation-pattern variants all match.
 */

import { describe, it, expect } from "vitest";
import {
  narrationWithoutEmitCheck,
  successTheaterCheck,
  isConfirmationShapedProse,
  runPostStreamChecks,
  DEFAULT_POST_STREAM_CHECKS,
} from "@/agent/unified/post-stream-checks";

describe("isConfirmationShapedProse — pattern coverage", () => {
  const positives: { name: string; text: string }[] = [
    { name: "cmp1nni72 — singular is-now-blocked", text: "Wednesday afternoon is now blocked." },
    { name: "cmp1nni72-variant — plural are-now-blocked", text: "Wednesday afternoons (12–5pm) are now blocked." },
    { name: "now-fully-protected", text: "Friday May 8 is now fully protected." },
    { name: "I've blocked", text: "I've blocked Friday for you." },
    { name: "I have rescheduled", text: "I have rescheduled the meeting to Thursday." },
    { name: "Got it — updated", text: "Got it — updated location to Konditori." },
    { name: "Done — moved", text: "Done — moved it to Thursday 3pm." },
    { name: "Booked X (sentence-start)", text: "Booked Friday 2pm for the team sync." },
    { name: "Cancelled X (mid-text)", text: "All set. Cancelled the Tuesday meeting." },
    { name: "is now booked", text: "The 2pm slot is now booked." },
    { name: "is now live", text: "Your Music Lessons link is now live." },
  ];

  for (const { name, text } of positives) {
    it(`MATCHES: ${name}`, () => {
      expect(isConfirmationShapedProse(text)).toBe(true);
    });
  }

  const negatives: { name: string; text: string }[] = [
    { name: "read-only state report", text: "Your timezone is set to America/New_York (EDT)." },
    { name: "question — clarifier", text: "Did you want Friday blocked, or just the morning?" },
    { name: "offer — not claim", text: "I can block Friday for you if you'd like." },
    { name: "future tense — conditional", text: "Friday will be blocked once you confirm the change." },
    { name: "empty string", text: "" },
    { name: "noun-shape only", text: "There's a 30-minute block on Friday." },
    { name: "shadow-disclosure question", text: "This would shadow 1 confirmed meeting — proceed?" },
  ];

  for (const { name, text } of negatives) {
    it(`DOES NOT match: ${name}`, () => {
      expect(isConfirmationShapedProse(text)).toBe(false);
    });
  }
});

describe("narrationWithoutEmitCheck — Phase A.5 / cmp1nni72", () => {
  it("fires on cmp1nni72 — confirmation prose + zero tool calls", () => {
    const result = narrationWithoutEmitCheck.check({
      fullText: "Wednesday afternoons (12–5pm) are now blocked.",
      toolCalls: [],
    });
    expect(result.fired).toBe(true);
    expect(result.scope).toBe("shape-1");
  });

  it("does NOT fire when any tool was called (even if prose claims write)", () => {
    // shape-3 belongs to successTheaterCheck; partition discipline.
    const result = narrationWithoutEmitCheck.check({
      fullText: "Done — moved it to Thursday 3pm.",
      toolCalls: [{ toolName: "session_update_time", success: true }],
    });
    expect(result.fired).toBe(false);
  });

  it("does NOT fire on read-only prose with no tool calls", () => {
    const result = narrationWithoutEmitCheck.check({
      fullText: "Your timezone is set to America/New_York (EDT).",
      toolCalls: [],
    });
    expect(result.fired).toBe(false);
  });

  it("does NOT fire on a clarifying question with no tool calls", () => {
    const result = narrationWithoutEmitCheck.check({
      fullText: "Did you want Friday blocked, or just morning hours?",
      toolCalls: [],
    });
    expect(result.fired).toBe(false);
  });

  it("does NOT fire on empty prose", () => {
    const result = narrationWithoutEmitCheck.check({
      fullText: "",
      toolCalls: [],
    });
    expect(result.fired).toBe(false);
  });
});

describe("successTheaterCheck — cost-reduction Phase 1.5 (E) shape-3", () => {
  it("fires when prose claims success but tool returned success: false", () => {
    const result = successTheaterCheck.check({
      fullText: "Done — moved it to Thursday 3pm.",
      toolCalls: [{ toolName: "session_update_time", success: false }],
    });
    expect(result.fired).toBe(true);
    expect(result.scope).toBe("shape-3");
    expect(result.reason).toContain("session_update_time");
  });

  it("does NOT fire when all tool calls succeeded", () => {
    const result = successTheaterCheck.check({
      fullText: "Done — moved it to Thursday 3pm.",
      toolCalls: [{ toolName: "session_update_time", success: true }],
    });
    expect(result.fired).toBe(false);
  });

  it("does NOT fire on zero tool calls (that's shape-1, owned by narrationWithoutEmitCheck)", () => {
    const result = successTheaterCheck.check({
      fullText: "Done — moved it to Thursday 3pm.",
      toolCalls: [],
    });
    expect(result.fired).toBe(false);
  });

  it("fires on multi-tool turn where one of N failed", () => {
    const result = successTheaterCheck.check({
      fullText: "Got it — updated location to Konditori.",
      toolCalls: [
        { toolName: "LOAD_active_sessions", success: undefined },
        { toolName: "session_update_location", success: false },
      ],
    });
    expect(result.fired).toBe(true);
    expect(result.reason).toContain("session_update_location");
  });

  it("does NOT fire when undefined-success calls are the only ones (LOAD-only turn)", () => {
    // LOAD_* tools return their data directly; success is undefined. A
    // LOAD-only turn isn't shape-3 — there's no write to lie about.
    const result = successTheaterCheck.check({
      fullText: "I've blocked Friday for you.",
      toolCalls: [{ toolName: "LOAD_calendar_context", success: undefined }],
    });
    expect(result.fired).toBe(false);
  });
});

describe("runPostStreamChecks — convergence behavior", () => {
  it("partitions the failure space — shape-1 fires when no tools, shape-3 when tools failed", () => {
    // Same prose, two different tool states. shape-1 wins on empty toolCalls.
    const proseClaim = "Wednesday afternoons (12–5pm) are now blocked.";

    const noTools = runPostStreamChecks({ fullText: proseClaim, toolCalls: [] });
    expect(noTools).toHaveLength(1);
    expect(noTools[0]?.name).toBe("narration-without-emit");
    expect(noTools[0]?.scope).toBe("shape-1");

    const failedTool = runPostStreamChecks({
      fullText: proseClaim,
      toolCalls: [{ toolName: "rule_add", success: false }],
    });
    expect(failedTool).toHaveLength(1);
    expect(failedTool[0]?.name).toBe("success-theater");
    expect(failedTool[0]?.scope).toBe("shape-3");
  });

  it("returns empty when neither check fires", () => {
    const result = runPostStreamChecks({
      fullText: "Your timezone is set to America/New_York (EDT).",
      toolCalls: [{ toolName: "LOAD_preferences", success: undefined }],
    });
    expect(result).toHaveLength(0);
  });

  it("uses DEFAULT_POST_STREAM_CHECKS when no override passed", () => {
    expect(DEFAULT_POST_STREAM_CHECKS.length).toBe(2);
    expect(DEFAULT_POST_STREAM_CHECKS.map((c) => c.name)).toEqual([
      "narration-without-emit",
      "success-theater",
    ]);
  });

  it("supports custom check array for bespoke callers", () => {
    const onlyA5 = runPostStreamChecks(
      { fullText: "I've blocked Friday for you.", toolCalls: [] },
      [narrationWithoutEmitCheck],
    );
    expect(onlyA5).toHaveLength(1);
    expect(onlyA5[0]?.name).toBe("narration-without-emit");
  });
});
