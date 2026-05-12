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
    // 2026-05-12 widening — present-progressive + future-intent shapes that v1
    // missed. The exact cancel-incident transcript: "Got it — cancelling this
    // meeting now." was the production-observed failure that motivated this batch.
    { name: "2026-05-12 cancel incident — Got it cancelling now", text: "Got it — cancelling this meeting now." },
    { name: "Got it — moving (present-progressive)", text: "Got it — moving it to Thursday." },
    { name: "Done — booking (present-progressive)", text: "Done — booking that slot now." },
    { name: "I'll cancel now (future-intent)", text: "I'll cancel that for you now." },
    { name: "I'll move right now (future-intent)", text: "I'll move it right now." },
    { name: "I'm cancelling (present-progressive, no preamble)", text: "I'm cancelling this for you." },
    { name: "I'm rescheduling (present-progressive)", text: "I'm rescheduling that to Thursday." },
    { name: "cancelling now (bare, no Got-it)", text: "Sounds good — cancelling that meeting now." },
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

  // 2026-05-12 regression — the cancel-incident transcript. Production prose
  // was "Got it — cancelling this meeting now." with zero tool calls. The v1
  // regex was too tight (past-tense only) and missed it. This fixture locks
  // the widened-regex shape so future tuning can't accidentally reopen the gap.
  it("regression: fires on 2026-05-12 cancel-incident exact transcript", () => {
    const result = narrationWithoutEmitCheck.check({
      fullText: "Got it — cancelling this meeting now.",
      toolCalls: [],
    });
    expect(result.fired).toBe(true);
    expect(result.scope).toBe("shape-1");
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

  it("fires on host-channel personal-link confirmation template (cmp2wlgke shape)", () => {
    // The cmp2wlgke incident: tool returned success: false due to grounding
    // check, but prose used the canonical "Here's a {X} link for {Y}"
    // template. Pre-fix the regex missed this shape entirely.
    const result = successTheaterCheck.check({
      fullText:
        'Here\'s a "testing is fun!!!" link for bobtester using your primary settings. Let me know if you want to adjust.',
      toolCalls: [{ toolName: "personal_link_create", success: false }],
    });
    expect(result.fired).toBe(true);
    expect(result.scope).toBe("shape-3");
  });

  it("fires on bare past-participle close ('Wednesdays blocked.')", () => {
    // Rule-add canonical template. Anchored to sentence end so negations
    // like "I haven't blocked anything yet." don't false-positive.
    const result = successTheaterCheck.check({
      fullText: "Wednesdays blocked.",
      toolCalls: [{ toolName: "rule_add", success: false }],
    });
    expect(result.fired).toBe(true);
    expect(result.scope).toBe("shape-3");
  });

  it("does NOT fire on negation prose ('I haven't blocked anything')", () => {
    // The bare past-participle regex requires the verb at sentence end —
    // negations have words after the verb so the anchor doesn't match.
    const result = successTheaterCheck.check({
      fullText: "I haven't blocked anything for you yet.",
      toolCalls: [{ toolName: "rule_add", success: false }],
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

  it("returns empty when no check fires", () => {
    const result = runPostStreamChecks({
      fullText: "Your timezone is set to America/New_York (EDT).",
      toolCalls: [{ toolName: "LOAD_preferences", success: undefined }],
    });
    expect(result).toHaveLength(0);
  });
});

describe("narrationLeakCheck — successful write + wrong-shape prose", () => {
  const successfulWrite = { toolName: "personal_link_create", success: true } as const;

  it("fires on prose > 240 chars when a successful write happened (cmp2qcnjy shape)", () => {
    const longProse =
      "Now I'll load the calendar to see today and tomorrow, then update the link " +
      "to auto-confirm one of those two dates. Based on the calendar, today is May 12 " +
      "and tomorrow is May 13. The most recent Susan link is already scheduled — " +
      "I'll update that existing link to correct the guestPicks field.";
    const result = runPostStreamChecks({
      fullText: longProse,
      toolCalls: [successfulWrite],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("narration-leak");
    expect(result[0]?.scope).toBe("length");
  });

  it("fires on 'Now I\\'ll' phrase even when prose is short", () => {
    const result = runPostStreamChecks({
      fullText: "Now I'll create that link for you.",
      toolCalls: [successfulWrite],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("narration-leak");
    expect(result[0]?.scope).toBe("thinking-out-loud");
  });

  it("fires on 'However, looking more carefully' (the cmp2qcnjy smoking gun)", () => {
    const result = runPostStreamChecks({
      fullText: "However, looking more carefully — let me update the link.",
      toolCalls: [successfulWrite],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("narration-leak");
    expect(result[0]?.scope).toBe("thinking-out-loud");
  });

  it("does NOT fire on a clean one-sentence confirmation", () => {
    const result = runPostStreamChecks({
      fullText: "Here's a coffee link for Christine today or tomorrow at Stanford Research Coupa Cafe. Let me know if you want to adjust.",
      toolCalls: [successfulWrite],
    });
    // narrationWithoutEmit won't fire (tools > 0), successTheater won't fire
    // (no success: false), narrationLeak won't fire (length under cap + no
    // forbidden phrases).
    expect(result).toHaveLength(0);
  });

  it("does NOT fire when no write happened — owned by narrationWithoutEmitCheck instead", () => {
    const result = runPostStreamChecks({
      fullText:
        "Now I'll load the calendar to see today and tomorrow, then update the link to auto-confirm one of those two dates. Based on the calendar, today is May 12 and tomorrow is May 13. The most recent Susan link is already scheduled.",
      toolCalls: [],
    });
    // Only narration-without-emit fires (the prose looks confirmation-shaped,
    // tools.length === 0). narrationLeak skips this case.
    expect(result.map((r) => r.name)).not.toContain("narration-leak");
  });

  it("does NOT fire when the write failed — owned by successTheaterCheck", () => {
    const result = runPostStreamChecks({
      fullText:
        "Now I'll create the link. The most recent Susan session is already scheduled. " +
        "Based on the calendar, the slot is taken. I'll update that existing link.",
      toolCalls: [{ toolName: "personal_link_create", success: false }],
    });
    // successTheater owns this (failed write + prose). narrationLeak skips.
    expect(result.map((r) => r.name)).not.toContain("narration-leak");
  });

  it("uses DEFAULT_POST_STREAM_CHECKS when no override passed", () => {
    expect(DEFAULT_POST_STREAM_CHECKS.length).toBe(3);
    expect(DEFAULT_POST_STREAM_CHECKS.map((c) => c.name)).toEqual([
      "narration-without-emit",
      "success-theater",
      "narration-leak",
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
