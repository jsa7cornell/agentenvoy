/**
 * Bench corpus + unit tests for the conversation-history scope detector.
 *
 * Source proposal: 2026-05-05_conversation-history-scope_decided-2026-05-05.md
 *
 * Coverage shape (per proposal §6 + §10 Phase 1):
 *   - 20 continuation shapes (must classify `continue`)
 *   - 20 pivot shapes (must classify `pivot`)
 *   - Trigger bundle replay: Bryan→Katie→Paul (cmot1fq5x00099w47jqjq90q6)
 *   - Report 2 replay: Bryan-cancel → protect-tuesday
 *   - Report 10 replay: Tutoring-create → buffer-set (nameless pivot via Signal 2)
 *   - 5 onboarding turn sequences (all expected `continue`, per §9.3)
 *   - Additive-connective cases ("and also", "plus", "as well")
 */

import { describe, it, expect } from "vitest";
import {
  scopeHistory,
  hasAnaphora,
  hasAdditiveConnective,
  extractProperNouns,
  isClosedTaskNarration,
  type HistoryMessage,
} from "@/agent/modules/_shared/history-scope";

function user(content: string): HistoryMessage {
  return { role: "user", content };
}
function envoy(content: string): HistoryMessage {
  return { role: "assistant", content };
}

// ─── Continuation corpus (20 shapes — all must classify `continue`) ─────────

describe("scopeHistory — continuation shapes (must keep history)", () => {
  const cases: Array<{ name: string; history: HistoryMessage[]; turn: string }> = [
    // Anaphora
    {
      name: "anaphora: 'actually make it 4pm instead'",
      history: [
        user("set up a 30 min call with Bryan tomorrow at 2pm"),
        envoy("Booked with Bryan tomorrow at 2pm."),
      ],
      turn: "actually make it 4pm instead",
    },
    {
      name: "anaphora: 'move that to friday'",
      history: [
        user("schedule lunch with Katie next week"),
        envoy("Sent Katie an invite for next Tuesday."),
      ],
      turn: "move that to friday",
    },
    {
      name: "anaphora: 'cancel it'",
      history: [
        user("book a 30 min with Paul tomorrow"),
        envoy("Booked with Paul tomorrow at 10am."),
      ],
      turn: "cancel it",
    },
    {
      name: "anaphora: 'send him another invite'",
      history: [
        user("invite bob to coffee"),
        envoy("Invited Bob for coffee."),
      ],
      turn: "send him another invite",
    },
    {
      name: "anaphora phrase: 'change the meeting to 3pm'",
      history: [
        user("set up call with Sarah tuesday"),
        envoy("Booked Sarah Tuesday at 2pm."),
      ],
      turn: "change the meeting to 3pm",
    },
    {
      name: "anaphora phrase: 'update the link'",
      history: [
        user("create a 30-min bookable link"),
        envoy("Created the bookable link."),
      ],
      turn: "update the link to 45 minutes",
    },
    // Re-reference prior contact by name
    {
      name: "re-name: 'reschedule the Bryan meeting to Friday'",
      history: [
        user("set up a 30 min call with Bryan tomorrow at 2pm"),
        envoy("Booked with Bryan tomorrow at 2pm."),
      ],
      turn: "reschedule the Bryan meeting to Friday",
    },
    {
      name: "re-name: contact several turns back (K=10 sees it)",
      history: [
        user("set up call with Bryan tomorrow"),
        envoy("Booked with Bryan tomorrow."),
        user("also create a coffee link"),
        envoy("Created the coffee link."),
        user("update my buffer to 10 minutes"),
        envoy("Updated buffer to 10 minutes."),
      ],
      turn: "do that for Bryan again next week",
    },
    // Additive-connective
    {
      name: "additive: 'and also book Paul'",
      history: [
        user("set up call with Bryan, and also one with Katie"),
        envoy("Booked Bryan; sent Katie an invite."),
      ],
      turn: "and also book Paul for Thursday",
    },
    {
      name: "additive: 'plus also schedule Frank'",
      history: [
        user("invite Sue to lunch"),
        envoy("Sent Sue an invite for lunch."),
      ],
      turn: "plus also schedule Frank for tomorrow",
    },
    {
      name: "additive: 'as well'",
      history: [
        user("block tuesday afternoon"),
        envoy("Blocked Tuesday afternoon."),
      ],
      turn: "block wednesday afternoon as well",
    },
    {
      name: "additive: 'also book a 1:1 with Tim'",
      history: [
        user("invite Lisa to coffee"),
        envoy("Invited Lisa for coffee."),
      ],
      turn: "also book a 1:1 with Tim tomorrow",
    },
    // Default-bias: ambiguous turns lacking signals → continue (open clarifier prior)
    {
      name: "ambiguous: 'yes, go ahead' after clarifier",
      history: [
        user("invite katie to lunch next week"),
        envoy("Want me to use Tuesday at 12?"),
      ],
      turn: "yes, go ahead",
    },
    {
      name: "ambiguous: 'sounds good' after clarifier",
      history: [
        user("set up coffee with Mark"),
        envoy("Should I use Tuesday at 9am?"),
      ],
      turn: "sounds good",
    },
    {
      name: "ambiguous: short affirmative",
      history: [
        user("create a bookable link for intros"),
        envoy("Want a 15 or 30 minute link?"),
      ],
      turn: "30",
    },
    // Onboarding sequences — proposal §9.3
    {
      name: "onboarding: name follow-up",
      history: [envoy("Welcome! What's your name?")],
      turn: "Alex",
    },
    {
      name: "onboarding: phone follow-up",
      history: [
        envoy("Welcome!"),
        user("Alex"),
        envoy("Hi Alex, what's a good phone number to reach you?"),
      ],
      turn: "555-1234",
    },
    {
      name: "onboarding: meeting types",
      history: [envoy("What kinds of meetings do you take?")],
      turn: "investor calls and customer 1:1s",
    },
    {
      name: "onboarding: business hours",
      history: [envoy("What are your business hours?")],
      turn: "9 to 5 weekdays",
    },
    {
      name: "onboarding: confirmation",
      history: [envoy("Sound right?")],
      turn: "yep",
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const result = scopeHistory(tc.history, tc.turn);
      expect(result.mode).toBe("continue");
      expect(result.prunedCount).toBe(0);
      expect(result.messages).toEqual(tc.history);
    });
  }
});

// ─── Pivot corpus (20 shapes — all must classify `pivot`) ───────────────────

describe("scopeHistory — pivot shapes (must drop history)", () => {
  const cases: Array<{ name: string; history: HistoryMessage[]; turn: string }> = [
    // Trigger bundle
    {
      name: "trigger: Bryan-create → Katie-invite",
      history: [
        user("set up a 30 min call with Bryan tomorrow at 2pm"),
        envoy("Booked with Bryan tomorrow at 2pm."),
      ],
      turn: "invite katie to lunch — some time next week or after if she prefers",
    },
    {
      name: "trigger: Katie-invite → Paul-invite",
      history: [
        user("set up a 30 min call with Bryan tomorrow at 2pm"),
        envoy("Booked with Bryan tomorrow at 2pm."),
        user("invite katie to lunch — some time next week"),
        envoy("Sent Katie an invite for Tuesday lunch."),
      ],
      turn: "get time with paul - phone - he can choose",
    },
    // Generic fresh-name pivots after closed-task narrations
    {
      name: "fresh name: Bob → Mary",
      history: [
        user("book Bob for a quick chat"),
        envoy("Booked Bob Tuesday at 10am."),
      ],
      turn: "schedule Mary for Wednesday",
    },
    {
      name: "fresh name: Lisa → Tom",
      history: [
        user("invite Lisa to coffee"),
        envoy("Invited Lisa for coffee."),
      ],
      turn: "book Tom for a 1:1 next week",
    },
    {
      name: "fresh name: Helen → David",
      history: [
        user("set up call with Helen tomorrow"),
        envoy("Booked Helen tomorrow at 3pm."),
      ],
      turn: "create a meeting with David Friday",
    },
    {
      name: "fresh name: Sue → Frank",
      history: [
        user("schedule Sue for monday"),
        envoy("Scheduled Sue for Monday at 2pm."),
      ],
      turn: "Frank wants 30 minutes thursday",
    },
    {
      name: "fresh name: Mike → Jenny",
      history: [
        user("invite Mike to lunch"),
        envoy("Invited Mike for lunch."),
      ],
      turn: "Jenny needs a slot tuesday",
    },
    {
      name: "fresh name: Kelly → Greg",
      history: [
        user("book Kelly for Wednesday"),
        envoy("Booked Kelly Wednesday at 11am."),
      ],
      turn: "Greg wants a 45-minute call",
    },
    {
      name: "fresh name: Owen → Pam",
      history: [
        user("schedule a 30min with Owen"),
        envoy("Booked Owen."),
      ],
      turn: "Pam needs an intro next week",
    },
    {
      name: "fresh name: Janet → Ryan",
      history: [
        user("set up coffee with Janet"),
        envoy("Booked coffee with Janet."),
      ],
      turn: "Ryan should get a slot tomorrow",
    },
    // Report 2: Bryan-cancel → protect-tuesday
    {
      name: "Report 2: Bryan-cancel → protect-tuesday",
      history: [
        user("cancel my meeting with Bryan"),
        envoy("Cancelled Bryan's meeting."),
      ],
      turn: "protect tuesday afternoon",
    },
    // Report 10: Tutoring-create → buffer-set (nameless pivot via Signal 2)
    {
      name: "Report 10: Tutoring-create → buffer-set",
      history: [
        user("create a Tutoring bookable for 1-hour sessions"),
        envoy("Tutoring link is updated to 1-hour sessions."),
      ],
      turn: "set buffer to 15 minutes",
    },
    // Report 7-shape: tuesday-protect → wednesday-only
    {
      name: "Report 7: tuesday-protect → wednesday-only protect",
      history: [
        user("protect tuesday afternoon"),
        envoy("Blocked Tuesday afternoon."),
      ],
      turn: "block off wednesday morning",
    },
    // More fresh-name pivots
    {
      name: "fresh name: Bob → Alice",
      history: [
        user("book Bob for Friday"),
        envoy("Booked Bob Friday."),
      ],
      turn: "Alice wants 20 minutes",
    },
    {
      name: "fresh name: Carl → Hannah",
      history: [
        user("set up Carl for tuesday"),
        envoy("Scheduled Carl Tuesday at 1pm."),
      ],
      turn: "Hannah is asking for time monday",
    },
    {
      name: "fresh name: Steve → Vivian",
      history: [
        user("invite Steve to lunch"),
        envoy("Invited Steve for lunch."),
      ],
      turn: "Vivian needs an intro call",
    },
    {
      name: "fresh name: Diana → Marcus",
      history: [
        user("invite Diana to coffee"),
        envoy("Invited Diana for coffee."),
      ],
      turn: "Marcus wants 30 minutes thursday",
    },
    {
      name: "fresh name: Wendy → Eddie",
      history: [
        user("set up call with Wendy"),
        envoy("Booked Wendy."),
      ],
      turn: "Eddie needs 15 minutes friday",
    },
    {
      name: "fresh name: Phillip → Naomi",
      history: [
        user("book Phillip for monday"),
        envoy("Booked Phillip Monday at 3pm."),
      ],
      turn: "Naomi wants a slot tomorrow",
    },
    {
      name: "fresh name: Kevin → Vanessa",
      history: [
        user("schedule Kevin for tuesday"),
        envoy("Scheduled Kevin Tuesday at 10am."),
      ],
      turn: "Vanessa wants a meeting too",
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const result = scopeHistory(tc.history, tc.turn);
      expect(result.mode).toBe("pivot");
      expect(result.prunedCount).toBe(tc.history.length);
      expect(result.messages).toEqual([]);
    });
  }
});

// ─── Signal-level unit tests ─────────────────────────────────────────────────

describe("hasAnaphora", () => {
  it("detects pronouns", () => {
    expect(hasAnaphora("make it 4pm")).toBe(true);
    expect(hasAnaphora("cancel that")).toBe(true);
    expect(hasAnaphora("send him a note")).toBe(true);
    expect(hasAnaphora("invite her too")).toBe(true);
  });
  it("detects determinative phrases", () => {
    expect(hasAnaphora("change the meeting to 3pm")).toBe(true);
    expect(hasAnaphora("update the link")).toBe(true);
    expect(hasAnaphora("delete the rule")).toBe(true);
  });
  it("does not fire on generic prose", () => {
    expect(hasAnaphora("invite Katie to lunch")).toBe(false);
    expect(hasAnaphora("set buffer to 15 minutes")).toBe(false);
  });
});

describe("hasAdditiveConnective", () => {
  it("detects additive phrases", () => {
    expect(hasAdditiveConnective("and also book Paul")).toBe(true);
    expect(hasAdditiveConnective("plus also schedule Frank")).toBe(true);
    expect(hasAdditiveConnective("block wednesday as well")).toBe(true);
    expect(hasAdditiveConnective("also book a 1:1 with Tim")).toBe(true);
  });
  it("does not fire on plain mentions", () => {
    expect(hasAdditiveConnective("invite Katie to lunch")).toBe(false);
    expect(hasAdditiveConnective("set buffer to 15")).toBe(false);
  });
});

describe("extractProperNouns", () => {
  it("extracts capitalized contact names", () => {
    expect(extractProperNouns("invite Katie to lunch")).toEqual(["Katie"]);
    expect(extractProperNouns("book Bryan and Paul")).toEqual(["Bryan", "Paul"]);
  });
  it("filters out sentence-initial common words", () => {
    expect(extractProperNouns("Set up a call")).toEqual([]);
    expect(extractProperNouns("Block Tuesday afternoon")).toEqual([]);
    expect(extractProperNouns("Tomorrow at 3pm")).toEqual([]);
  });
  it("filters out weekday/month names", () => {
    expect(extractProperNouns("Tuesday is busy")).toEqual([]);
    expect(extractProperNouns("invite Mark on Friday")).toEqual(["Mark"]);
  });
  it("filters out 'Tutoring' (Report 10 nameless-pivot shape)", () => {
    expect(extractProperNouns("Tutoring link is updated")).toEqual([]);
  });
});

describe("isClosedTaskNarration", () => {
  it("recognizes completion-verb openers", () => {
    expect(isClosedTaskNarration("Booked with Bryan tomorrow at 2pm.")).toBe(true);
    expect(isClosedTaskNarration("Sent Katie an invite for Tuesday lunch.")).toBe(true);
    expect(isClosedTaskNarration("Cancelled Bryan's meeting.")).toBe(true);
    expect(isClosedTaskNarration("Updated buffer to 10 minutes.")).toBe(true);
  });
  it("recognizes completion verb mid-sentence", () => {
    expect(isClosedTaskNarration("Tutoring link is updated to 1-hour sessions.")).toBe(true);
  });
  it("treats clarifier turns as open", () => {
    expect(isClosedTaskNarration("Want me to use Tuesday at 12?")).toBe(false);
    expect(isClosedTaskNarration("What's your name?")).toBe(false);
  });
  it("does not fire on generic prose", () => {
    expect(isClosedTaskNarration("Hi there.")).toBe(false);
    expect(isClosedTaskNarration("Welcome!")).toBe(false);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("scopeHistory — edge cases", () => {
  it("empty history → continue with 0 prunedCount", () => {
    const result = scopeHistory([], "invite Katie to lunch");
    expect(result.mode).toBe("continue");
    expect(result.prunedCount).toBe(0);
    expect(result.messages).toEqual([]);
  });
  it("first turn with anaphora → continue", () => {
    const result = scopeHistory([], "make it 4pm");
    expect(result.mode).toBe("continue");
  });
});
