/**
 * Integration test for the scheduling-precheck routing decisions that
 * PR-δ (proposal 2026-04-22 §9.3.3) inserts ahead of the Sonnet
 * scheduling pass.
 *
 * Updated 2026-04-27 for chat-decisioning-layer-redesign PR1 (§2.3 R1):
 * single match defaults to `deterministic-create`; multi-match (>= 2) is the
 * only trigger for `multi-match-disambiguate`. The legacy `"schedule"` intent
 * is still accepted at the precheck boundary (guest call-site) and is
 * handled identically to `create_link`.
 */

import { describe, it, expect } from "vitest";
import { schedulingPrecheck } from "@/lib/scheduling-precheck";

describe("scheduling-precheck integration — Jon-case end-to-end", () => {
  it("maps the proposal's verbatim Jon utterance with single existing active link to deterministic-create (R1 default-to-create)", () => {
    // Snapshot modeled on feedback report cmo9n0t5u (§1).
    // Pre-PR1 this routed to marco-disambiguate; under R1 a single match
    // defaults to a fresh create (handleCreateLink is reversible pre-confirm).
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

    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Jon");
      expect(result.args.topic).toBe("bike ride");
      expect(result.args.duration).toBe(180);
    }
  });

  it("routes to deterministic-create when the Jon link is 'agreed' single-match (R1 default-to-create)", () => {
    // Pre-PR1 (PR #83 Round-2) this routed to marco-disambiguate even for a
    // single agreed-status match. After the chat-decisioning-layer-redesign,
    // single-match defaults to create under R1; multi-match is the only
    // marco trigger now.
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
    }
  });

  it("routes to multi-match-disambiguate when there are TWO active Jon links (>= 2 only)", () => {
    const activeSessions = [
      {
        id: "sess_a",
        title: "John + Jon (1:1)",
        guestName: "Jon",
        linkCode: "code_a",
        status: "active",
      },
      {
        id: "sess_b",
        title: "John + Jon (bike ride)",
        guestName: "Jon",
        linkCode: "code_b",
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

    expect(result.kind).toBe("multi-match-disambiguate");
    if (result.kind === "multi-match-disambiguate") {
      expect(result.matchedLinkIds.sort()).toEqual(["code_a", "code_b"]);
      expect(result.originatingIntent).toBe("create_link");
    }
  });

  it("routes to deterministic-create when the Jon link is 'cancelled' (no usable existing link)", () => {
    const activeSessions = [
      {
        id: "cmo9jxs1w-session",
        title: "John + Jon",
        guestName: "Jon",
        linkCode: "qx4bmg",
        status: "cancelled",
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

    // Single match → deterministic-create under R1; reason still carries
    // the echo suffix.
    expect(result.kind).toBe("deterministic-create");
    expect(result.reason).toContain("echo of prior envoy detected");
  });
});
