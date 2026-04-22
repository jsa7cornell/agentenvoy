/**
 * Integration test for the scheduling-precheck routing decisions that
 * PR-δ (proposal 2026-04-22 §9.3.3) inserts ahead of the Sonnet
 * scheduling pass.
 *
 * This suite covers the end-to-end decision shape the route handler
 * consumes — the Jon-case round-trip from a realistic activeSessions
 * snapshot + recent thread turns to the three PrecheckResult branches.
 * The route-level wiring (channel/chat/route.ts) is validated by
 * typecheck + unit tests; a full handler integration test would require
 * NextAuth/Prisma/Anthropic mocks that are out of scope for this PR.
 */

import { describe, it, expect } from "vitest";
import { schedulingPrecheck } from "@/lib/scheduling-precheck";

describe("scheduling-precheck integration — Jon-case end-to-end", () => {
  it("maps the proposal's verbatim Jon utterance with existing active link to marco-disambiguate", () => {
    // Snapshot modeled on feedback report cmo9n0t5u (§1).
    const activeSessions = [
      {
        id: "cmo9jxs1w-session",
        title: "John + Jon",
        guestName: "Jon",
        linkCode: "qx4bmg",
        status: "active",
      },
      {
        id: "other-session",
        title: "John + Bob",
        guestName: "Bob",
        linkCode: "p2xq9k",
        status: "active",
      },
    ];
    const recentThreadTurns = [
      { role: "user", content: "Set up a Jon bike ride please" },
      { role: "envoy", content: "Created a Jon bike ride link (qx4bmg)." },
    ];

    const result = schedulingPrecheck({
      classifiedIntent: "schedule",
      userMessage:
        "Set up a 3-hour bike ride with Jon for next week. I'm offering Mon–Fri.",
      activeSessions,
      recentThreadTurns,
      echoFlag: false,
    });

    expect(result.kind).toBe("marco-disambiguate");
    if (result.kind === "marco-disambiguate") {
      expect(result.existingLinkCode).toBe("qx4bmg");
      expect(result.guest).toBe("Jon");
    }
  });

  it("routes to deterministic-create when the Jon link is 'agreed' (not 'active')", () => {
    const activeSessions = [
      {
        id: "cmo9jxs1w-session",
        title: "John + Jon",
        guestName: "Jon",
        linkCode: "qx4bmg",
        status: "agreed",
      },
    ];
    const result = schedulingPrecheck({
      classifiedIntent: "schedule",
      userMessage: "Set up a 3-hour bike ride with Jon for next week",
      activeSessions,
      recentThreadTurns: [],
      echoFlag: false,
    });

    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Jon");
      expect(result.args.topic).toBe("bike ride");
      expect(result.args.duration).toBe(180);
      expect(result.args.dateRangeKeyword).toBe("next week");
    }
  });

  it("annotates reason with echo suffix when echoFlag=true", () => {
    const result = schedulingPrecheck({
      classifiedIntent: "schedule",
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
      recentThreadTurns: [],
      echoFlag: true,
    });

    expect(result.kind).toBe("marco-disambiguate");
    expect(result.reason).toContain("echo of prior envoy detected");
  });
});
