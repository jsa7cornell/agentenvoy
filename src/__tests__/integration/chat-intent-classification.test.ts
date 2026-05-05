/**
 * Chat-turn intent classification regression suite.
 *
 * Proposal: 2026-04-21_dashboard-chat-intent-router §4.2.
 *
 * Companion to `intent-classification.test.ts` — but one layer up: this
 * suite pins the TURN-level intent classifier that routes a host's chat
 * utterance to schedule / profile / rule / inquire / unclear. The
 * scheduling-time steering classifier (open/soft/narrow/exclusive) is
 * exercised by the neighbouring suite.
 *
 * Running:
 *   op run --env-file=.env.tpl -- npm run test:integration -- chat-intent
 *
 * Acceptance thresholds (§4.2):
 *   - Overall exact-match accuracy ≥ 90%
 *   - Zero profile↔schedule cross-misclassifications (blocker — the whole
 *     point of the router is to keep profile edits out of the action
 *     planner, where they dead-end or cause harm)
 *   - `unclear` precision: of the 11 cases expected to emit `unclear`,
 *     at least 9 must do so (precision ≥ 80%) — `unclear` is the
 *     ambiguity-first relief valve; false positives are OK, false
 *     negatives are the real cost (an ambiguous schedule gets booked
 *     under the wrong assumption).
 */

import { describe, it, expect } from "vitest";
import { classifyChatIntent } from "@/agent/intent-classifier";
import {
  CHAT_INTENT_VALUES,
  HOST_CHAT_INTENT_VALUES,
  type ChatIntent,
  type HostChatIntent,
} from "@/lib/intent";

type Case = {
  message: string;
  expected: ChatIntent;
  notes?: string;
};

const CASES: Case[] = [
  // ── schedule (10) ─────────────────────────────────────────────────────
  { message: "Book Bob tomorrow at 2pm", expected: "schedule" },
  { message: "Schedule 30 min with Sarah next week", expected: "schedule" },
  { message: "Cancel that meeting", expected: "schedule", notes: "verb-only cancel" },
  { message: "Hold 10am Wednesday", expected: "schedule" },
  { message: "Move the Suzie meeting to Thursday", expected: "schedule" },
  { message: "grab 30 min with Jay", expected: "schedule" },
  { message: "set up a video call with Nathan", expected: "schedule" },
  { message: "reschedule Bob for Friday afternoon", expected: "schedule" },
  { message: "archive the Josh thread", expected: "schedule" },
  { message: "What about Thursday at 4?", expected: "schedule", notes: "chooser-reply shape" },

  // ── profile (4) — all stubs in v1 ─────────────────────────────────────
  { message: "Make my default meeting time 12 to 5", expected: "profile" },
  { message: "Update my phone to 555-1234", expected: "profile" },
  { message: "I prefer video meetings by default", expected: "profile" },
  { message: "Change my default duration to 45 minutes", expected: "profile" },

  // ── rule (4) — all stubs in v1 ────────────────────────────────────────
  { message: "No meetings on Fridays", expected: "rule" },
  { message: "I'm out next week", expected: "rule" },
  { message: "Block Dec 20 through 31", expected: "rule" },
  { message: "Add a lunch break noon to 1", expected: "rule" },

  // ── inquire (6) ───────────────────────────────────────────────────────
  { message: "What's on my calendar tomorrow?", expected: "inquire" },
  { message: "How many pending meetings do I have?", expected: "inquire" },
  { message: "Show me my rules", expected: "inquire" },
  { message: "What did Suzie say?", expected: "inquire" },
  { message: "How do I share a link?", expected: "inquire" },
  { message: "What are my current defaults?", expected: "inquire" },

  // ── unclear (11) — ambiguity-first rule ───────────────────────────────
  {
    message: "Let's do 12 to 5",
    expected: "unclear",
    notes: "schedule vs profile ambiguity — §1.5 primary case",
  },
  {
    message: "Move it to Tuesday",
    expected: "unclear",
    notes: "pronoun without referent",
  },
  {
    message: "12 to 5",
    expected: "unclear",
    notes: "bare temporal fragment",
  },
  {
    message: "Book Bob at 2pm AND update my phone to 555-1234",
    expected: "unclear",
    notes: "conjunction spanning two intents",
  },
  {
    message: "Make it 3pm instead",
    expected: "unclear",
    notes: "referent-less chooser reply outside a session context",
  },
  {
    message: "Fridays",
    expected: "unclear",
    notes: "bare day — could be rule or schedule",
  },
  {
    message: "no Bob meetings this week",
    expected: "unclear",
    notes: "schedule-vs-rule ambiguity",
  },
  {
    message: "my usual time with Bob",
    expected: "unclear",
    notes: "profile-vs-schedule — 'usual' is a profile signal",
  },
  {
    message: "update the Thursday meeting and my phone",
    expected: "unclear",
    notes: "explicit two-intent conjunction",
  },
  {
    message: "I want afternoons",
    expected: "unclear",
    notes: "could be profile preference or rule or current-session constraint",
  },
  {
    message: "that one",
    expected: "unclear",
    notes: "pure pronoun, no referent",
  },
];

const hasGatewayKey = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL);

describe.skipIf(!hasGatewayKey)(
  "chat intent classification regression (pre-merge gate)",
  () => {
    it("covers ≥ 35 cases across all five tiers including 11 unclear", () => {
      expect(CASES.length).toBeGreaterThanOrEqual(35);
      const tiers = new Set(CASES.map((c) => c.expected));
      for (const v of CHAT_INTENT_VALUES) {
        expect(tiers.has(v), `missing tier: ${v}`).toBe(true);
      }
      const unclearCount = CASES.filter((c) => c.expected === "unclear").length;
      expect(unclearCount).toBeGreaterThanOrEqual(11);
    });

    it(
      "classifies all cases with ≥ 90% overall accuracy, ≥ 80% unclear precision, and zero profile↔schedule misses",
      async () => {
        // Serial dispatch with throttle — firing 35 classifier calls in
        // parallel (or even back-to-back) trips the gateway rate limiter,
        // which makes the classifier fall back to `schedule` and destroys
        // the signal. Sequential + 500ms gap runs ~90s — under the 240s
        // timeout. Retry-noise still possible; failure report distinguishes
        // semantic misses from rate-limit fallbacks by including both.
        const results: Array<{ c: Case; actual: ChatIntent; retried: boolean }> = [];
        for (const c of CASES) {
          // Explicit "guest" per PLAYBOOK Rule 19f — all classifyChatIntent
          // call sites must pass role explicitly (CI grep enforces this).
          const { intent, retried } = await classifyChatIntent(c.message, {}, "guest");
          results.push({ c, actual: intent.kind, retried });
          await new Promise((r) => setTimeout(r, 2000));
        }

        const failures: Array<{
          message: string;
          expected: ChatIntent;
          actual: ChatIntent;
          retried: boolean;
          notes?: string;
        }> = [];
        let correct = 0;
        let unclearCorrect = 0;
        let unclearTotal = 0;
        let retriedCount = 0;
        const profileScheduleMisses: typeof failures = [];

        for (const { c, actual, retried } of results) {
          if (retried) retriedCount++;
          if (actual === c.expected) correct++;
          else failures.push({ message: c.message, expected: c.expected, actual, retried, notes: c.notes });

          if (c.expected === "unclear") {
            unclearTotal++;
            if (actual === "unclear") unclearCorrect++;
          }

          const isProfileScheduleMiss =
            (c.expected === "profile" && actual === "schedule") ||
            (c.expected === "schedule" && actual === "profile");
          if (isProfileScheduleMiss) {
            profileScheduleMisses.push({
              message: c.message,
              expected: c.expected,
              actual,
              retried,
              notes: c.notes,
            });
          }
        }

        const accuracy = correct / CASES.length;
        const unclearPrecision = unclearTotal > 0 ? unclearCorrect / unclearTotal : 1;

        const report = [
          `accuracy=${(accuracy * 100).toFixed(1)}% (${correct}/${CASES.length})`,
          `unclearPrecision=${(unclearPrecision * 100).toFixed(1)}% (${unclearCorrect}/${unclearTotal})`,
          `profileScheduleMisses=${profileScheduleMisses.length}`,
          `retriedCount=${retriedCount} (retries indicate transient errors / rate-limit)`,
          failures.length
            ? `failures:\n${failures.map((f) => `  - "${f.message}" expected=${f.expected} actual=${f.actual}${f.retried ? " [retried]" : ""}${f.notes ? ` (${f.notes})` : ""}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        expect(profileScheduleMisses, `profile↔schedule blocker\n${report}`).toHaveLength(0);
        expect(accuracy, `accuracy below 90% threshold\n${report}`).toBeGreaterThanOrEqual(0.9);
        expect(
          unclearPrecision,
          `unclear precision below 80% threshold\n${report}`,
        ).toBeGreaterThanOrEqual(0.8);
      },
      240_000,
    );
  },
);

// Always-on smoke — when the gateway key is absent the `describe.skipIf`
// block is inert; keep a non-LLM case so vitest doesn't report "no tests".
describe("chat intent classification regression — suite smoke", () => {
  it("CASES shape is well-formed", () => {
    for (const c of CASES) {
      expect(typeof c.message).toBe("string");
      expect(c.message.length).toBeGreaterThan(0);
      expect(CHAT_INTENT_VALUES).toContain(c.expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Host-side classifier — chat-decisioning-layer-redesign PR1.
//
// Smaller corpus (10 cases — R6 waived per the PR1 plan) hitting each of
// the 7 host intents with at least one example, plus the three create /
// modify / cancel discriminators surfaced as the primary fix in the
// proposal §10 prod-bug catalog.
// ---------------------------------------------------------------------------

type HostCase = {
  message: string;
  expected: HostChatIntent;
  notes?: string;
};

const HOST_CASES: HostCase[] = [
  // create_link (3) — including Bug #1 + Bug #4
  {
    message: "create office hours link - tuesdays from 9am-1pm",
    expected: "create_link",
    notes: "Bug #1 — was misclassified as schedule pre-PR1",
  },
  {
    message: "2 hour bike ride with katie",
    expected: "create_link",
    notes: "Bug #4 — must default to create even with active Katie link",
  },
  {
    message: "make a 30 min link for Sarah",
    expected: "create_link",
  },

  // modify_link (2)
  {
    message: "shift the bike ride to Friday",
    expected: "modify_link",
    notes: "modification verb targeting existing thing",
  },
  {
    message: "change the Sarah link to 45 min",
    expected: "modify_link",
  },

  // cancel_link (1)
  {
    message: "cancel my Sarah link",
    expected: "cancel_link",
  },

  // edit_preference (1)
  {
    message: "make my default 30 min",
    expected: "edit_preference",
  },

  // query_calendar (1)
  {
    message: "what's on my calendar tomorrow?",
    expected: "query_calendar",
  },

  // query_event (1)
  {
    message: "when is my Sarah call?",
    expected: "query_event",
  },

  // chat (1) — Bug #2
  {
    message: "change to light mode",
    expected: "chat",
    notes: "Bug #2 — display-settings request must classify as chat, not modify_link",
  },

  // guest-picks disambiguator (Mode C, 2026-05-05) — when host explicitly
  // says the OTHER PARTY chooses time/location/format, route to create_link
  // (open-invite scheduling link), NOT book_with_person.
  // Trigger: feedback bundle cmot67s6e000hk2jsdr7jd86z; host said "grab a bike
  // ride with katie next week or the week after - she chooses location and time"
  // and was incorrectly routed to book_with_person (asked for guest's email).
  {
    message: "grab a bike ride with [Name] next week or the week after - she chooses location and time",
    expected: "create_link",
    notes: "Mode C — guest-picks signal (\"she chooses location and time\") → create_link, not book_with_person",
  },
  {
    message: "set up coffee with [Name] sometime, let them pick the time",
    expected: "create_link",
    notes: "Mode C — \"let them pick\" → create_link",
  },
  {
    message: "send [Name] an open invite for a 30-min call — any time works for them",
    expected: "create_link",
    notes: "Mode C — explicit \"open invite\" + \"any time works for them\" → create_link",
  },

  // book_with_person (2) — classic committed-booking shape MUST still route here.
  // Defends against over-aggressive guest-picks disambiguator stealing legitimate
  // bilateral bookings.
  {
    message: "book a 30-min call with [Name] Tuesday at 2pm",
    expected: "book_with_person",
    notes: "Mode C guard — host names specific time + contact + commit-now → book_with_person",
  },
  {
    message: "find a time with [Name] next week — check both our calendars",
    expected: "book_with_person",
    notes: "Mode C guard — explicit bilateral framing stays book_with_person",
  },
];

describe.skipIf(!hasGatewayKey)(
  "host chat intent classification (PR1 — chat-decisioning-layer-redesign)",
  () => {
    it("covers each of the 7 host intents at least once across 10 cases", () => {
      expect(HOST_CASES.length).toBeGreaterThanOrEqual(10);
      const seen = new Set(HOST_CASES.map((c) => c.expected));
      for (const v of HOST_CHAT_INTENT_VALUES) {
        expect(seen.has(v), `missing host intent: ${v}`).toBe(true);
      }
    });

    it(
      "classifies all host cases with ≥ 80% exact-match accuracy and zero create↔chat misses (Bug #2 invariant)",
      async () => {
        // Same throttle pattern as the guest suite — sequential + 2s gap.
        const results: Array<{
          c: HostCase;
          actual: HostChatIntent | string;
          retried: boolean;
        }> = [];
        for (const c of HOST_CASES) {
          const { intent, retried } = await classifyChatIntent(
            c.message,
            {},
            "host",
          );
          results.push({ c, actual: intent.kind, retried });
          await new Promise((r) => setTimeout(r, 2000));
        }

        const failures: Array<{
          message: string;
          expected: HostChatIntent;
          actual: string;
          retried: boolean;
          notes?: string;
        }> = [];
        let correct = 0;
        let retriedCount = 0;
        const createChatMisses: typeof failures = [];

        for (const { c, actual, retried } of results) {
          if (retried) retriedCount++;
          if (actual === c.expected) correct++;
          else
            failures.push({
              message: c.message,
              expected: c.expected,
              actual,
              retried,
              notes: c.notes,
            });

          // Bug #2 invariant: a `chat` turn must NEVER classify as a
          // create/modify/cancel — those would route into the precheck
          // and potentially modify state for an app-chrome request.
          const isCreateChatMiss =
            (c.expected === "chat" &&
              (actual === "create_link" ||
                actual === "modify_link" ||
                actual === "cancel_link")) ||
            (c.expected === "create_link" && actual === "chat");
          if (isCreateChatMiss) {
            createChatMisses.push({
              message: c.message,
              expected: c.expected,
              actual,
              retried,
              notes: c.notes,
            });
          }
        }

        const accuracy = correct / HOST_CASES.length;
        const report = [
          `accuracy=${(accuracy * 100).toFixed(1)}% (${correct}/${HOST_CASES.length})`,
          `createChatMisses=${createChatMisses.length}`,
          `retriedCount=${retriedCount}`,
          failures.length
            ? `failures:\n${failures
                .map(
                  (f) =>
                    `  - "${f.message}" expected=${f.expected} actual=${f.actual}${f.retried ? " [retried]" : ""}${f.notes ? ` (${f.notes})` : ""}`,
                )
                .join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        expect(
          createChatMisses,
          `Bug #2 invariant violated\n${report}`,
        ).toHaveLength(0);
        expect(
          accuracy,
          `host accuracy below 80% threshold\n${report}`,
        ).toBeGreaterThanOrEqual(0.8);
      },
      120_000,
    );
  },
);

// Always-on smoke for the host corpus shape.
describe("host chat intent classification — suite smoke", () => {
  it("HOST_CASES shape is well-formed and references known host intents", () => {
    for (const c of HOST_CASES) {
      expect(typeof c.message).toBe("string");
      expect(c.message.length).toBeGreaterThan(0);
      expect(HOST_CHAT_INTENT_VALUES).toContain(c.expected);
    }
  });
});
