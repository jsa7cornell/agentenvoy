/**
 * `narration-emission-consistency` postStream guard tests.
 *
 * Covers the failure mode reported 2026-05-05 (FeedbackReport `cmot66ofp001dj35x05v20c1u`,
 * `cmot69r49000927l4whxjq7en`): composer narrates a state-change effect
 * ("X is now blocked", "the action I emitted stands") but no action was
 * emitted (typically because a preEmit guard suppressed it on a prior
 * retry, or the composer simply forgot to emit).
 *
 * Cross-reference: `proposals/2026-05-05_state-integrity-and-architectural-attention-bias.md`.
 */
import { describe, it, expect } from "vitest";
import {
  needsNarrationEmissionRetry,
  narrationEmissionConsistencyGuard,
} from "@/agent/modules/_shared/post-stream-guards";
import type { ActionRequest } from "@/agent/actions";

const noActions: ActionRequest[] = [];

describe("needsNarrationEmissionRetry — true positives", () => {
  it("flags 'Friday May 8 is now fully protected' with no actions emitted", () => {
    const text = "Two things came in together. Friday May 8 is now fully protected.";
    expect(needsNarrationEmissionRetry(text, noActions)).not.toBeNull();
  });

  it("flags 'is blocked. The action I emitted stands' with no actions", () => {
    const text =
      "Tuesday May 12, 9 AM-noon is blocked with no conflicts on that date. The action I emitted stands.";
    expect(needsNarrationEmissionRetry(text, noActions)).not.toBeNull();
  });

  it("flags \"I've blocked Friday\" with no parsed actions", () => {
    const text = "I've blocked Friday for you.";
    expect(needsNarrationEmissionRetry(text, noActions)).not.toBeNull();
  });

  it("flags 'is now blocked' phrasing", () => {
    expect(
      needsNarrationEmissionRetry("Wednesday afternoon is now blocked.", noActions),
    ).not.toBeNull();
  });

  it("flags 'is now updated' phrasing", () => {
    expect(
      needsNarrationEmissionRetry(
        "Your default duration is now updated to 30 minutes.",
        noActions,
      ),
    ).not.toBeNull();
  });

  it("flags 'the action I emitted landed' phrasing", () => {
    expect(
      needsNarrationEmissionRetry("Done. The action I emitted landed cleanly.", noActions),
    ).not.toBeNull();
  });

  it("flags 'is now fully protected' phrasing", () => {
    expect(
      needsNarrationEmissionRetry("Friday is now fully protected.", noActions),
    ).not.toBeNull();
  });
});

describe("needsNarrationEmissionRetry — true negatives", () => {
  it("does NOT flag 'Your timezone is set to EDT' (read-only state report)", () => {
    // Tightrope case: 'is set to' looks claim-ish but is a read of existing
    // state, not a write effect. Verb-shaped regex must avoid this.
    const text = "Your timezone is set to America/New_York (EDT).";
    expect(needsNarrationEmissionRetry(text, noActions)).toBeNull();
  });

  it("does NOT flag a confirmation prompt", () => {
    const text =
      "This would shadow 1 confirmed meeting on Friday May 8 (a workout). Confirm to proceed?";
    expect(needsNarrationEmissionRetry(text, noActions)).toBeNull();
  });

  it("does NOT flag claim text when matching action emitted", () => {
    const action: ActionRequest = {
      action: "update_availability_rule",
      params: { operation: "add" },
    };
    const text = "Friday May 8 is now fully protected.";
    expect(needsNarrationEmissionRetry(text, [action])).toBeNull();
  });

  it("does NOT flag 'I can block Friday for you' (offer, not claim)", () => {
    expect(
      needsNarrationEmissionRetry("I can block Friday for you if you'd like.", noActions),
    ).toBeNull();
  });

  it("does NOT flag clarifying question", () => {
    expect(
      needsNarrationEmissionRetry(
        "Did you want Friday blocked, or just morning hours?",
        noActions,
      ),
    ).toBeNull();
  });

  it("does NOT flag empty text", () => {
    expect(needsNarrationEmissionRetry("", noActions)).toBeNull();
  });

  it("does NOT flag 'will be blocked once you confirm' (future tense)", () => {
    expect(
      needsNarrationEmissionRetry(
        "Friday will be blocked once you confirm the change.",
        noActions,
      ),
    ).toBeNull();
  });
});

describe("narrationEmissionConsistencyGuard — wrapper", () => {
  const moduleContext = {
    user: { id: "u1", name: null, email: "u@e" },
    surface: "dashboard-host" as const,
  };

  it("returns null when no claim phrase fires", () => {
    expect(
      narrationEmissionConsistencyGuard.check({
        text: "What date works for you?",
        parsedActions: [],
        moduleContext,
      }),
    ).toBeNull();
  });

  it("returns a flagged result when claim fires with no actions", () => {
    const result = narrationEmissionConsistencyGuard.check({
      text: "Friday May 8 is now fully protected.",
      parsedActions: [],
      moduleContext,
    });
    expect(result).not.toBeNull();
    expect(result?.flaggedReason).toMatch(/claim-without-emit/);
    // Narrow off the rewrite branch — this guard only emits retry shape.
    if (result && result.kind !== "rewrite") {
      expect(result.hint).toMatch(/state change|emit|suppress/i);
    }
  });

  it("does NOT fire when claim is matched by an emitted action", () => {
    const action: ActionRequest = {
      action: "update_availability_rule",
      params: { operation: "add" },
    };
    expect(
      narrationEmissionConsistencyGuard.check({
        text: "Friday May 8 is now fully protected.",
        parsedActions: [action],
        moduleContext,
      }),
    ).toBeNull();
  });

  it("has a stable name", () => {
    expect(narrationEmissionConsistencyGuard.name).toBe("narration-emission-consistency");
  });
});
