/**
 * `forward-projection-consistency` postStream guard tests.
 *
 * Covers the failure mode reported 2026-05-05 (FeedbackReport
 * `cmot63s7x0001k2js8f96655r`): composer in `event_action` proactively
 * suggested widening scope ("Want me to open up earlier mornings 7-10 AM?")
 * when the host had only changed format and location. Three prose-discipline
 * tunes (commits 7f0b6ca / 3a12911 / 4248a08) reduced this class but did
 * not eliminate it; this guard is the structural backstop.
 *
 * Cluster scope (allowlist — wired in via per-module postStreamGuards):
 *   event_action, manage_setup, book_with_person.
 *
 * Excluded clusters (guard NOT wired): inquire (legitimate clarifying
 * follow-ups), chat (free-form fallthrough), recalibrate (structured
 * next-step framing per the conversational-onboarding-vision proposal §2.7a).
 */
import { describe, it, expect } from "vitest";
import {
  needsForwardProjectionRetry,
  forwardProjectionConsistencyGuard,
} from "@/agent/modules/_shared/post-stream-guards";
import type { ActionRequest } from "@/agent/actions";

const noActions: ActionRequest[] = [];

describe("needsForwardProjectionRetry — true positives", () => {
  it("flags 'Want me to open up earlier mornings (7-10 AM)?' (production case)", () => {
    const text =
      "Updated to an in-person coffee at Konditori. Want me to open up earlier mornings (7-10 AM) so Larry has more options?";
    expect(needsForwardProjectionRetry(text)).not.toBeNull();
  });

  it("flags 'Want me to also block Saturday?'", () => {
    const text = "Friday May 8 is now fully protected. Want me to also block Saturday?";
    expect(needsForwardProjectionRetry(text)).not.toBeNull();
  });

  it("flags 'Should I also add Sunday to the block?'", () => {
    expect(
      needsForwardProjectionRetry("Done. Should I also add Sunday to the block?"),
    ).not.toBeNull();
  });

  it("flags 'Want me to widen the window?'", () => {
    expect(
      needsForwardProjectionRetry("Coffee at Konditori it is. Want me to widen the window?"),
    ).not.toBeNull();
  });

  it("flags 'Want me to expand the time range?'", () => {
    expect(
      needsForwardProjectionRetry("Set. Want me to expand the time range so she has more options?"),
    ).not.toBeNull();
  });

  it("flags 'Should I consider other days?'", () => {
    expect(
      needsForwardProjectionRetry("Updated. Should I consider other days as backup?"),
    ).not.toBeNull();
  });

  it("flags 'Would you like me to widen the window?'", () => {
    expect(
      needsForwardProjectionRetry("Locked in. Would you like me to widen the window?"),
    ).not.toBeNull();
  });

  it("flags 'Would you like me to expand the slots?'", () => {
    expect(
      needsForwardProjectionRetry("Done. Would you like me to expand the slots?"),
    ).not.toBeNull();
  });

  it("flags 'Want to also widen this?'", () => {
    expect(
      needsForwardProjectionRetry("Set. Want to also widen this to evenings?"),
    ).not.toBeNull();
  });

  it("flags 'Want me to consider weekend mornings?'", () => {
    expect(
      needsForwardProjectionRetry("Confirmed. Want me to consider weekend mornings too?"),
    ).not.toBeNull();
  });

  it("flags 'Want me to add Sunday afternoons?'", () => {
    expect(
      needsForwardProjectionRetry("Done. Want me to add Sunday afternoons as well?"),
    ).not.toBeNull();
  });
});

describe("needsForwardProjectionRetry — true negatives", () => {
  it("does NOT flag a plain narration with no projection", () => {
    expect(
      needsForwardProjectionRetry("Updated to in-person coffee at Konditori."),
    ).toBeNull();
  });

  it("does NOT flag a confirmation prompt", () => {
    expect(
      needsForwardProjectionRetry(
        "This would shadow 1 confirmed meeting on Friday May 8. Confirm to proceed?",
      ),
    ).toBeNull();
  });

  it("does NOT flag a clarifying question without projection verbs", () => {
    expect(
      needsForwardProjectionRetry("Did you mean Friday morning or Friday afternoon?"),
    ).toBeNull();
  });

  it("does NOT flag empty text", () => {
    expect(needsForwardProjectionRetry("")).toBeNull();
  });

  it("does NOT flag 'Want me to' without a projection verb", () => {
    // Bare "Want me to know..." or "Want me to send..." are not projection.
    expect(
      needsForwardProjectionRetry("Want me to send the link now?"),
    ).toBeNull();
  });

  it("does NOT flag 'Should I' without 'also' or 'consider'", () => {
    expect(
      needsForwardProjectionRetry("Should I go ahead and send it?"),
    ).toBeNull();
  });
});

describe("forwardProjectionConsistencyGuard — wrapper", () => {
  const moduleContext = {
    user: { id: "u1", name: null, email: "u@e" },
    surface: "dashboard-host" as const,
  };

  it("returns null when no projection phrase fires", () => {
    expect(
      forwardProjectionConsistencyGuard.check({
        text: "Updated to in-person coffee at Konditori.",
        parsedActions: noActions,
        moduleContext,
      }),
    ).toBeNull();
  });

  it("returns a flagged result when projection fires", () => {
    const result = forwardProjectionConsistencyGuard.check({
      text:
        "Updated to in-person coffee at Konditori. Want me to open up earlier mornings (7-10 AM)?",
      parsedActions: noActions,
      moduleContext,
    });
    expect(result).not.toBeNull();
    expect(result?.flaggedReason).toMatch(/forward-projection/);
    expect(result?.hint.length).toBeGreaterThan(0);
  });

  it("fires regardless of whether actions were emitted (cluster scope handles legitimacy)", () => {
    // Unlike narration-emission-consistency, forward-projection bleed can
    // occur alongside a legit emit (e.g. update_link succeeded + projection
    // tail). The cluster allowlist is the safety net, not parsedActions.
    const action: ActionRequest = {
      action: "update_link",
      params: {},
    };
    const result = forwardProjectionConsistencyGuard.check({
      text:
        "Updated to in-person coffee at Konditori. Want me to open up earlier mornings (7-10 AM)?",
      parsedActions: [action],
      moduleContext,
    });
    expect(result).not.toBeNull();
  });

  it("has a stable name", () => {
    expect(forwardProjectionConsistencyGuard.name).toBe("forward-projection-consistency");
  });
});
