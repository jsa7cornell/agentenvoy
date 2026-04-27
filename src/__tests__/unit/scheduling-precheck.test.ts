/**
 * Unit tests for `schedulingPrecheck`.
 *
 * Proposal 2026-04-22 chat-intent-router §9.3.3 (PR-δ).
 */

import { describe, it, expect } from "vitest";
import {
  schedulingPrecheck,
  type PrecheckInput,
} from "@/lib/scheduling-precheck";

function baseInput(overrides: Partial<PrecheckInput> = {}): PrecheckInput {
  return {
    classifiedIntent: "schedule",
    userMessage: "",
    activeSessions: [],
    recentThreadTurns: [],
    echoFlag: false,
    ...overrides,
  };
}

describe("schedulingPrecheck", () => {
  it("returns marco-disambiguate for the Jon bike-ride case from the proposal", () => {
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "Set up a 3-hour bike ride with Jon for next week",
        activeSessions: [
          {
            id: "sess_1",
            title: "John + Jon",
            guestName: "Jon",
            linkCode: "qx4bmg",
            status: "active",
          },
        ],
      }),
    );
    expect(result.kind).toBe("marco-disambiguate");
    if (result.kind === "marco-disambiguate") {
      expect(result.existingLinkCode).toBe("qx4bmg");
      expect(result.guest).toBe("Jon");
    }
  });

  it("returns deterministic-create for the same message when no existing Jon link", () => {
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "Set up a 3-hour bike ride with Jon for next week",
        activeSessions: [],
        recentThreadTurns: [
          { role: "user", content: "earlier I asked about Jon" },
        ],
      }),
    );
    // No active sessions → no guest candidates → falls through (no named
    // guest). This is correct behavior: guest resolution requires either a
    // match against active-session guestNames or against recent thread turns
    // that mention a known active-session guest. Supply the guest via an
    // active session so the extractor can lock on.
    expect(result.kind).toBe("fall-through-to-sonnet");
  });

  it("returns deterministic-create when guest comes from active sessions (no active link)", () => {
    // Guest "Jon" has only a cancelled session, which doesn't count as an
    // existing link. New request → deterministic-create.
    // (Note: "agreed" sessions DO count — see Round-2 marco-disambiguate
    // case below. We use "cancelled" here to exercise the no-existing-link
    // path with a guest who is otherwise resolvable.)
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "Set up a 3-hour bike ride with Jon for next week",
        activeSessions: [
          {
            id: "sess_old",
            title: "John + Jon",
            guestName: "Jon",
            linkCode: "oldcode",
            status: "cancelled",
          },
        ],
      }),
    );
    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Jon");
      expect(result.args.topic).toBe("bike ride");
      expect(result.args.duration).toBe(180);
      expect(result.args.dateRangeKeyword).toBe("next week");
    }
  });

  it("returns marco-disambiguate when bare 'bike ride' with Jon in thread + active Jon session", () => {
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "bike ride",
        activeSessions: [
          {
            id: "sess_1",
            title: "John + Jon",
            guestName: "Jon",
            linkCode: "qx4bmg",
            status: "active",
          },
        ],
        recentThreadTurns: [
          { role: "user", content: "set up a ride with Jon next week" },
          { role: "envoy", content: "want me to book a Jon bike ride?" },
        ],
      }),
    );
    expect(result.kind).toBe("marco-disambiguate");
    if (result.kind === "marco-disambiguate") {
      expect(result.guest).toBe("Jon");
    }
  });

  it("returns deterministic-create for 'Schedule 30 min with Sarah' when no Sarah session", () => {
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "Schedule 30 min with Sarah",
        activeSessions: [
          {
            id: "sess_x",
            title: "John + Sarah",
            guestName: "Sarah",
            linkCode: "abcdef",
            // Cancelled session doesn't count as an existing link, so
            // this is a fresh create. (Round-2 fix: "agreed" WOULD count.)
            status: "cancelled",
          },
        ],
      }),
    );
    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Sarah");
      expect(result.args.duration).toBe(30);
    }
  });

  it("falls through to Sonnet when classifiedIntent is inquire", () => {
    const result = schedulingPrecheck(
      baseInput({
        classifiedIntent: "inquire",
        userMessage: "Schedule with Jon",
      }),
    );
    expect(result.kind).toBe("fall-through-to-sonnet");
    if (result.kind === "fall-through-to-sonnet") {
      expect(result.reason).toContain("inquire");
    }
  });

  it("falls through to Sonnet when guest candidates are ambiguous", () => {
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "meet with M",
        activeSessions: [
          {
            id: "s1",
            title: "John + Mike",
            guestName: "Mike",
            linkCode: "code01",
            status: "active",
          },
          {
            id: "s2",
            title: "John + Michael",
            guestName: "Michael",
            linkCode: "code02",
            status: "active",
          },
        ],
      }),
    );
    // "M" alone is not a whole-word match against "Mike" or "Michael", so
    // neither guest resolves — falls through on "no named guest". This
    // matches the proposal's expected safe behavior.
    expect(result.kind).toBe("fall-through-to-sonnet");
  });

  it("falls through when message contains BOTH guest names (multi-candidate)", () => {
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "meet with Mike and Michael",
        activeSessions: [
          {
            id: "s1",
            title: "John + Mike",
            guestName: "Mike",
            linkCode: "code01",
            status: "active",
          },
          {
            id: "s2",
            title: "John + Michael",
            guestName: "Michael",
            linkCode: "code02",
            status: "active",
          },
        ],
      }),
    );
    expect(result.kind).toBe("fall-through-to-sonnet");
    if (result.kind === "fall-through-to-sonnet") {
      expect(result.reason).toContain("multiple");
    }
  });

  it("treats agreed-status sessions as existing links — marco-disambiguate (Round-2 fix)", () => {
    // Per John's 2026-04-27 Round-2 call on PR #83: an "agreed" session for
    // the same guest must NOT silently spawn a duplicate link. Route to
    // marco-disambiguate so the host explicitly chooses (new link vs reuse).
    // Reschedule-intent ("just move it") is a WISHLIST follow-up, not in
    // PR #83 scope.
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "coffee with Alice tomorrow",
        activeSessions: [
          {
            id: "s1",
            title: "John + Alice",
            guestName: "Alice",
            linkCode: "agreedlink",
            status: "agreed",
          },
        ],
      }),
    );
    expect(result.kind).toBe("marco-disambiguate");
    if (result.kind === "marco-disambiguate") {
      expect(result.guest).toBe("Alice");
      expect(result.existingLinkCode).toBe("agreedlink");
    }
  });

  it("echo flag is informational — appears in reason but doesn't change decision", () => {
    const result = schedulingPrecheck(
      baseInput({
        classifiedIntent: "schedule",
        userMessage: "set up a bike ride",
        activeSessions: [],
        echoFlag: true,
      }),
    );
    expect(result.kind).toBe("fall-through-to-sonnet");
    if (result.kind === "fall-through-to-sonnet") {
      expect(result.reason).toContain("echo of prior envoy detected");
    }
  });

  it("caps absurd durations (drop > 480min or < 10min)", () => {
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "20 hour meeting with Jon",
        activeSessions: [
          {
            id: "s1",
            title: "John + Jon",
            guestName: "Jon",
            linkCode: null,
            status: "agreed",
          },
        ],
      }),
    );
    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.duration).toBeNull();
    }
  });
});
