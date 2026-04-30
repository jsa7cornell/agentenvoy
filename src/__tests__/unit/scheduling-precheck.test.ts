/**
 * Unit tests for `schedulingPrecheck`.
 *
 * Originally proposal 2026-04-22 chat-intent-router §9.3.3 (PR-δ).
 * Updated 2026-04-27 for chat-decisioning-layer-redesign PR1:
 *   - `marco-disambiguate` → `multi-match-disambiguate` (matchCount >= 2 only).
 *   - Single match under `create_link` defaults to `deterministic-create` (R1).
 *   - New `modify_link` / `cancel_link` branches.
 *   - 5 bug repros (proposal §10 prod-bug catalog).
 *
 * Updated 2026-04-30 (feedback report cmokrgfly000529unsajrqqli):
 *   - `create_link` / `schedule` no longer multi-match-disambiguates at any
 *     matchCount. The classifier already separates create from modify/cancel;
 *     the matcher trusts that signal and always goes to deterministic-create.
 *   - `multi-match-disambiguate` now only fires from `modify_link` /
 *     `cancel_link`.
 */

import { describe, it, expect } from "vitest";
import {
  schedulingPrecheck,
  type PrecheckInput,
} from "@/agent/matcher";

function baseInput(overrides: Partial<PrecheckInput> = {}): PrecheckInput {
  return {
    classifiedIntent: "create_link",
    userMessage: "",
    activeSessions: [],
    recentThreadTurns: [],
    echoFlag: false,
    ...overrides,
  };
}

describe("schedulingPrecheck", () => {
  it("returns deterministic-create for the Jon bike-ride case with single active link (R1 default-to-create)", () => {
    // Pre-redesign this was marco-disambiguate; under R1 (handleCreateLink
    // is reversible-without-side-effects pre-confirm), a single match
    // defaults to create. Multi-match is the only marco trigger now.
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
    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Jon");
      expect(result.args.topic).toBe("bike ride");
      expect(result.args.duration).toBe(180);
    }
  });

  it("returns deterministic-create even with TWO active links for the same guest (create_link trusts classifier)", () => {
    // Post-2026-04-30 (feedback cmokrgfly000529unsajrqqli): create_link no
    // longer multi-match-disambiguates. Edit verbs ("change", "shift",
    // "cancel") classify as modify_link/cancel_link — those still
    // disambiguate. A creation-classified message goes straight to create.
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "Set up a 3-hour bike ride with Jon for next week",
        activeSessions: [
          {
            id: "sess_1",
            title: "John + Jon (bike ride)",
            guestName: "Jon",
            linkCode: "qx4bmg",
            status: "active",
          },
          {
            id: "sess_2",
            title: "John + Jon (1:1)",
            guestName: "Jon",
            linkCode: "abc123",
            status: "agreed",
          },
        ],
      }),
    );
    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Jon");
      expect(result.args.topic).toBe("bike ride");
      expect(result.args.duration).toBe(180);
    }
  });

  it("returns fall-through-to-sonnet for the same message when no existing Jon link", () => {
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

  it("returns deterministic-create for bare 'bike ride' with single active Jon session (single-match defaults to create)", () => {
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
    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Jon");
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
            // this is a fresh create.
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

  it("agreed-status single match under create_link → deterministic-create (R1 default-to-create)", () => {
    // Pre-PR1 (PR #83 Round-2) this routed to marco-disambiguate even for a
    // single agreed-status match. After the chat-decisioning-layer-redesign,
    // single-match defaults to create under R1; only multi-match fires marco.
    // (Reschedule-intent surfacing is a separate WISHLIST follow-up.)
    const result = schedulingPrecheck(
      baseInput({
        classifiedIntent: "create_link",
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
    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Alice");
      expect(result.args.topic).toBe("coffee");
      expect(result.args.dateRangeKeyword).toBe("tomorrow");
    }
  });

  it("echo flag is informational — appears in reason but doesn't change decision", () => {
    const result = schedulingPrecheck(
      baseInput({
        classifiedIntent: "create_link",
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

  // -------------------------------------------------------------------------
  // PR-ε / 2026-04-27 prod regression: thread-fallback over-anchoring.
  // Host had an active link with Katie, then asked "get time with bob, phone
  // call". The thread-fallback re-resolved to Katie because Bob isn't a
  // known guest. Fix: if the message names a *new* person, suppress thread
  // fallback and hand off to Sonnet.
  // -------------------------------------------------------------------------

  it("falls through when message names a new guest unknown to active sessions (Bob/Katie regression)", () => {
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "get time with bob, phone call",
        activeSessions: [
          {
            id: "sess_katie",
            title: "John + Katie",
            guestName: "Katie",
            linkCode: "katielink",
            status: "active",
          },
        ],
        recentThreadTurns: [
          { role: "user", content: "set up time with Katie next week" },
          { role: "envoy", content: "I'll send Katie a link" },
        ],
      }),
    );
    expect(result.kind).toBe("fall-through-to-sonnet");
    if (result.kind === "fall-through-to-sonnet") {
      expect(result.reason).toContain("unrecognized guest");
    }
  });

  it("preserves thread-fallback when message has no naming pattern (e.g. 'reschedule')", () => {
    // No "with X" / "for X" / "and X" in the message → guard doesn't fire →
    // thread-fallback resolves to Katie. With single match + create_link,
    // R1 defaults to deterministic-create.
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "let's reschedule it",
        activeSessions: [
          {
            id: "sess_katie",
            title: "John + Katie",
            guestName: "Katie",
            linkCode: "katielink",
            status: "active",
          },
        ],
        recentThreadTurns: [
          { role: "user", content: "set up time with Katie next week" },
        ],
      }),
    );
    expect(result.kind).toBe("deterministic-create");
    if (result.kind === "deterministic-create") {
      expect(result.args.inviteeName).toBe("Katie");
    }
  });

  it("does not suppress on benign 'for me' / 'with the team' phrasing (stopwords)", () => {
    // "for me" → "me" is a stopword, no suppression. Thread-fallback resolves
    // Jon and produces deterministic-create (single match, R1 default).
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "block out 30 min for me tomorrow",
        activeSessions: [
          {
            id: "sess_jon",
            title: "John + Jon",
            guestName: "Jon",
            linkCode: "jonlink",
            status: "active",
          },
        ],
        recentThreadTurns: [
          { role: "user", content: "schedule a ride with Jon" },
        ],
      }),
    );
    expect(result.kind).toBe("deterministic-create");
  });

  it("does not suppress when the named token IS a known guest from active sessions", () => {
    // "with Jon" matches the regex but Jon is a known guest → not unrecognized
    // → guard doesn't fire. Direct match on Jon → single match + create_link →
    // deterministic-create (R1).
    const result = schedulingPrecheck(
      baseInput({
        userMessage: "talk with Jon and Jon's team about it",
        activeSessions: [
          {
            id: "sess_jon",
            title: "John + Jon",
            guestName: "Jon",
            linkCode: "jonlink",
            status: "active",
          },
        ],
      }),
    );
    expect(result.kind).toBe("deterministic-create");
  });

  // -------------------------------------------------------------------------
  // PR1 prod-bug repros (proposal 2026-04-27 §10).
  // -------------------------------------------------------------------------

  describe("PR1 prod-bug repros (chat-decisioning-layer-redesign §10)", () => {
    it("Bug #1: 'create office hours link - tuesdays from 9am-1pm' → no marco (no named guest)", () => {
      // Pre-PR1 the host classifier emitted `schedule` here and the precheck
      // anchored on a stale guest from earlier turns, marco-spinning. With
      // role-aware classification the host classifier emits `create_link` and
      // here there's no named guest → fall through.
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "create_link",
          userMessage: "create office hours link - tuesdays from 9am-1pm",
          activeSessions: [],
          recentThreadTurns: [],
        }),
      );
      expect(result.kind).toBe("fall-through-to-sonnet");
    });

    it("Bug #2: 'change to light mode' with classifiedIntent='chat' falls through", () => {
      // Display-settings turn — host classifier emits `chat`. Non-event
      // intents short-circuit at the top gate.
      const result = schedulingPrecheck(
        baseInput({
          // PrecheckClassifiedIntent doesn't include "chat"; non-event intents
          // are filtered by the route before precheck is even called. We test
          // the closest in-domain proxy: a non-event intent like `inquire`
          // bails out at the same top gate. (Direct "chat" routing is
          // covered by the chat-route integration test in PR1 Step 11.)
          classifiedIntent: "inquire",
          userMessage: "change to light mode",
          activeSessions: [],
        }),
      );
      expect(result.kind).toBe("fall-through-to-sonnet");
      if (result.kind === "fall-through-to-sonnet") {
        expect(result.reason).toContain("inquire");
      }
    });

    it("Bug #3 extension: 'get time with bob, phone call' falls through with unrecognized-guest reason", () => {
      // Already covered above (Bob/Katie regression) — adding here under the
      // PR1 bug-repro umbrella so a redesign drift breaks the explicit
      // bug-#3 assertion, not just a generic "regression" test.
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "create_link",
          userMessage: "get time with bob, phone call",
          activeSessions: [
            {
              id: "sess_katie",
              title: "John + Katie",
              guestName: "Katie",
              linkCode: "katielink",
              status: "active",
            },
          ],
          recentThreadTurns: [
            { role: "user", content: "set up time with Katie next week" },
          ],
        }),
      );
      expect(result.kind).toBe("fall-through-to-sonnet");
      if (result.kind === "fall-through-to-sonnet") {
        expect(result.reason).toContain("unrecognized guest");
      }
    });

    it("Bug #4: '2 hour bike ride with katie' with active Katie link → deterministic-create (R1)", () => {
      // Pre-PR1 this routed to marco even though the host's verb was
      // unambiguously creative ("bike ride"). R1 default-to-create + R8
      // (handleCreateLink reversible pre-confirm) means a single match
      // becomes a fresh create.
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "create_link",
          userMessage: "2 hour bike ride with katie",
          activeSessions: [
            {
              id: "sess_katie",
              title: "John + Katie",
              guestName: "Katie",
              linkCode: "katielink",
              status: "active",
            },
          ],
        }),
      );
      expect(result.kind).toBe("deterministic-create");
      if (result.kind === "deterministic-create") {
        expect(result.args.inviteeName).toBe("Katie");
        expect(result.args.topic).toBe("bike ride");
        expect(result.args.duration).toBe(120);
      }
    });

    it("Bug #5 R1 regression: single-match under create_link never multi-match-disambiguates", () => {
      // Direct R1 invariant: with classifiedIntent='create_link' and exactly
      // one existing active/agreed link, the result must be
      // deterministic-create — never multi-match-disambiguate.
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "create_link",
          userMessage: "30 min with Sarah next week",
          activeSessions: [
            {
              id: "s1",
              title: "John + Sarah",
              guestName: "Sarah",
              linkCode: "sarahcode",
              status: "active",
            },
          ],
        }),
      );
      expect(result.kind).toBe("deterministic-create");
      expect(result.kind).not.toBe("multi-match-disambiguate");
    });

    it("feedback cmokrgfly000529unsajrqqli: 'find time with john 30 mins tomorrow' with TWO John links → deterministic-create", () => {
      // Repro of the 2026-04-30 host feedback: matcher was firing
      // multi-match-disambiguate on plain creation messages. Post-fix the
      // matcher trusts the create_link classification and always creates.
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "create_link",
          userMessage: "find time with john 30 mins tomorrow",
          activeSessions: [
            {
              id: "s1",
              title: "John + Tester",
              guestName: "John",
              linkCode: "2ej9h8",
              status: "active",
            },
            {
              id: "s2",
              title: "VC: John + Tester",
              guestName: "John",
              linkCode: "pvvnhu",
              status: "active",
            },
          ],
        }),
      );
      expect(result.kind).toBe("deterministic-create");
      if (result.kind === "deterministic-create") {
        expect(result.args.inviteeName).toBe("John");
        expect(result.args.duration).toBe(30);
        expect(result.args.dateRangeKeyword).toBe("tomorrow");
      }
    });
  });

  // -------------------------------------------------------------------------
  // PR1 modify_link / cancel_link branch coverage.
  // -------------------------------------------------------------------------

  describe("modify_link / cancel_link (PR1 redesign)", () => {
    it("modify_link with single match → deterministic-modify", () => {
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "modify_link",
          userMessage: "change the Sarah link to 45 min",
          activeSessions: [
            {
              id: "s1",
              title: "John + Sarah",
              guestName: "Sarah",
              linkCode: "sarahcode",
              status: "active",
            },
          ],
        }),
      );
      expect(result.kind).toBe("deterministic-modify");
      if (result.kind === "deterministic-modify") {
        expect(result.sessionId).toBe("s1");
        expect(result.linkCode).toBe("sarahcode");
      }
    });

    it("modify_link with multi-match → multi-match-disambiguate (originatingIntent: modify_link)", () => {
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "modify_link",
          userMessage: "shift Jon's meeting to Friday",
          activeSessions: [
            {
              id: "s1",
              title: "John + Jon (1:1)",
              guestName: "Jon",
              linkCode: "code01",
              status: "active",
            },
            {
              id: "s2",
              title: "John + Jon (bike ride)",
              guestName: "Jon",
              linkCode: "code02",
              status: "agreed",
            },
          ],
        }),
      );
      expect(result.kind).toBe("multi-match-disambiguate");
      if (result.kind === "multi-match-disambiguate") {
        expect(result.originatingIntent).toBe("modify_link");
        expect(result.matchedLinkIds.sort()).toEqual(["code01", "code02"]);
      }
    });

    it("modify_link with no existing link → fall-through-to-sonnet", () => {
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "modify_link",
          userMessage: "change Sarah's link",
          activeSessions: [
            {
              id: "s1",
              title: "John + Sarah",
              guestName: "Sarah",
              linkCode: "old",
              status: "cancelled",
            },
          ],
        }),
      );
      expect(result.kind).toBe("fall-through-to-sonnet");
      if (result.kind === "fall-through-to-sonnet") {
        expect(result.reason).toContain("modify_link with no existing link");
      }
    });

    it("cancel_link with single match → deterministic-cancel", () => {
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "cancel_link",
          userMessage: "cancel the Sarah link",
          activeSessions: [
            {
              id: "s1",
              title: "John + Sarah",
              guestName: "Sarah",
              linkCode: "sarahcode",
              status: "active",
            },
          ],
        }),
      );
      expect(result.kind).toBe("deterministic-cancel");
      if (result.kind === "deterministic-cancel") {
        expect(result.sessionId).toBe("s1");
        expect(result.linkCode).toBe("sarahcode");
      }
    });

    it("cancel_link with multi-match → multi-match-disambiguate (originatingIntent: cancel_link)", () => {
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "cancel_link",
          userMessage: "drop Jon's link",
          activeSessions: [
            {
              id: "s1",
              title: "John + Jon (1:1)",
              guestName: "Jon",
              linkCode: "code01",
              status: "active",
            },
            {
              id: "s2",
              title: "John + Jon (bike ride)",
              guestName: "Jon",
              linkCode: "code02",
              status: "agreed",
            },
          ],
        }),
      );
      expect(result.kind).toBe("multi-match-disambiguate");
      if (result.kind === "multi-match-disambiguate") {
        expect(result.originatingIntent).toBe("cancel_link");
      }
    });

    it("cancel_link with no existing link → fall-through-to-sonnet", () => {
      const result = schedulingPrecheck(
        baseInput({
          classifiedIntent: "cancel_link",
          userMessage: "cancel Sarah's link",
          activeSessions: [],
        }),
      );
      expect(result.kind).toBe("fall-through-to-sonnet");
    });
  });
});
