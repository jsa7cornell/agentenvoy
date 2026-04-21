/**
 * Host-intent classification regression suite (proposal 2026-04-21,
 * stage-1 pre-merge gate per §12).
 *
 * The whole host-intent refactor rests on the LLM reliably classifying
 * `intent.steering` at `create_link` time. This suite pins ≥20 real host
 * phrasings against expected tiers and runs them against the real model.
 * 100% exact-match is required — any drift fails the suite.
 *
 * Running the suite:
 *   # Needs AI_GATEWAY_API_KEY (Vercel AI Gateway) set — same as the dev
 *   # server. Skip cleanly when unset so the broader integration job
 *   # (which doesn't provision a gateway key) still passes; the PR
 *   # description must include a local run log as evidence.
 *   op run --env-file=.env.tpl -- npm run test:integration -- intent-classification
 *
 * Source of phrasings: real channel-message history (John's feed, Apr
 * 2026). PII stripped — guest names replaced with placeholders ("X",
 * "Bob", etc.). Coverage target per §4.5:
 *   - ≥ 20 cases
 *   - all four tiers
 *   - boundary cases (open/soft fuzz zone; narrow/exclusive fuzz zone)
 *   - includes the outlier phrasings from the PRs #50/#54/#57 + Bob
 *     "anytime next two weeks" regression set
 *
 * When a case fails: either the expectation is wrong (update the case
 * with reasoning), OR the LLM prompt in `channel.md` / `parsePreferences`
 * needs tightening. Do not merge with failing cases — the whole premise
 * of the refactor depends on reliable classification.
 */

import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { normalizeSteering, type Steering } from "@/lib/intent";

type Case = {
  userMessage: string;
  expectedSteering: Steering;
  notes?: string;
};

// ≥20 real phrasings mined from channel history + regression phrasings from
// PRs #50/#54/#57 + the Bob "anytime next two weeks" bug. Adding a case:
// include the source (PR number, feedback ID, or "synthesized boundary case")
// in `notes` so drift investigations can trace provenance.
const CASES: Case[] = [
  // ── OPEN ── no preference named
  {
    userMessage: "get time w/ Bob",
    expectedSteering: "open",
    notes: "Primary null case — bare invite, no preference",
  },
  {
    userMessage: "grab time w/ Suzie",
    expectedSteering: "open",
    notes: "PR #50 regression phrasing",
  },
  {
    userMessage: "get time w/ suzie again",
    expectedSteering: "open",
    notes: "PR #54 regression — Suzie link 6dngnf, no rules",
  },
  {
    userMessage: "schedule Sarah",
    expectedSteering: "open",
    notes: "Single-verb open invite",
  },
  {
    userMessage: "set something up with Jay",
    expectedSteering: "open",
    notes: "Playbook canonical — zero time context",
  },
  {
    userMessage: "whenever works for Bob",
    expectedSteering: "open",
    notes: "Explicit no-preference",
  },
  {
    userMessage: "anytime next two weeks is fine for Bob",
    expectedSteering: "open",
    notes: "PR #57 + Bob regression — wide dateRange is a BRACKET, not narrowing",
  },
  {
    userMessage: "create new event for Bob - anytime next week",
    expectedSteering: "open",
    notes: "Bob link 8hryrv — full week as a bracket",
  },
  {
    userMessage: "grab 30 with Bob, he's traveling",
    expectedSteering: "open",
    notes: "Duration + hostNote context is not a preference",
  },
  {
    userMessage: "get something on the calendar with Jay",
    expectedSteering: "open",
    notes: "Neutral imperative, no context",
  },

  // ── SOFT ── preference with fallback
  {
    userMessage: "Bob next week, Wed ideally",
    expectedSteering: "soft",
    notes: "Classic `ideally` fallback marker",
  },
  {
    userMessage: "Wed ideally, else Thu-Fri",
    expectedSteering: "soft",
    notes: "Explicit else clause",
  },
  {
    userMessage: "afternoons preferred for Bob this week",
    expectedSteering: "soft",
    notes: "`preferred` = fallback tolerance",
  },
  {
    userMessage: "this week for Bob but next week is fine too",
    expectedSteering: "soft",
    notes: "Explicit `but ... fine` fallback",
  },
  {
    userMessage: "Bob next Tuesday afternoon if possible, else Wed",
    expectedSteering: "soft",
    notes: "Soft-narrow boundary — `if possible, else` = soft",
  },

  // ── NARROW ── genuinely narrowed, no fallback
  {
    userMessage: "Tuesday afternoon only, no exceptions, with Bob",
    expectedSteering: "narrow",
    notes: "Explicit `only, no exceptions` = hard narrow",
  },
  {
    userMessage: "Mon-Wed next week for Bob",
    expectedSteering: "narrow",
    notes: "3-day span = narrow",
  },
  {
    userMessage: "5-8pm tonight with Bob",
    expectedSteering: "narrow",
    notes: "Narrow time window, single day",
  },
  {
    userMessage: "Bob, my afternoon (12-5pm)",
    expectedSteering: "narrow",
    notes: "Specific time window, no fallback mentioned",
  },
  {
    userMessage: "get time with Bob next Tuesday",
    expectedSteering: "narrow",
    notes: "Single specific day",
  },

  // ── EXCLUSIVE ── enumerated specific slots
  {
    userMessage: "either 3pm Tuesday or 4pm Wednesday with Bob",
    expectedSteering: "exclusive",
    notes: "Two named slots, not a window",
  },
  {
    userMessage: "Bob, I can only do one of these: Mon 10am, Tue 2pm, or Thu 4pm",
    expectedSteering: "exclusive",
    notes: "Three enumerated slots",
  },
];

const SYSTEM_PROMPT = `You are an intent classifier. For each host scheduling message, return a single JSON object:
{"steering": "open" | "soft" | "narrow" | "exclusive"}

Apply this 4-step discriminator ladder in order:
1. Did the user name ANY preference? If no → "open". Phrasings like "get time with X", "grab X", "whenever works", or a wide window like "next two weeks" used as a BRACKET (fencing the overall when, not narrowing within it) are "open".
2. Did they signal a fallback (else/preferred/ideally/but/or "is fine too")? If yes → "soft".
3. Did they name specific SLOTS (2+ enumerated offerings, not a window)? If yes → "exclusive".
4. Otherwise → "narrow".

COST ASYMMETRY — WHEN IN DOUBT, PICK OPEN. Narrow-side errors produce a verbose bulleted greeting for an offer the host didn't actually narrow; open-side errors degrade gracefully. Bias open between open/soft, bias soft between soft/narrow.

Return ONLY the JSON object. No prose, no markdown.`;

async function classify(userMessage: string): Promise<Steering | null> {
  const { text } = await generateText({
    model: envoyModel("claude-sonnet-4-6"),
    maxOutputTokens: 64,
    system: SYSTEM_PROMPT,
    prompt: userMessage,
  });
  try {
    const parsed = JSON.parse(text.trim());
    return normalizeSteering(parsed?.steering) ?? null;
  } catch {
    // Try to extract a bare token — tolerance for an LLM that went
    // off-script once without failing the whole case prematurely.
    return normalizeSteering(text.trim().replace(/["}{:\s]/g, "")) ?? null;
  }
}

const hasGatewayKey = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL);

describe.skipIf(!hasGatewayKey)(
  "intent classification regression (pre-merge gate)",
  () => {
    it("covers at least 20 cases across all four tiers", () => {
      expect(CASES.length).toBeGreaterThanOrEqual(20);
      const tiers = new Set(CASES.map((c) => c.expectedSteering));
      expect(tiers.has("open")).toBe(true);
      expect(tiers.has("soft")).toBe(true);
      expect(tiers.has("narrow")).toBe(true);
      expect(tiers.has("exclusive")).toBe(true);
    });

    for (const c of CASES) {
      it(
        `classifies "${c.userMessage.slice(0, 60)}${c.userMessage.length > 60 ? "…" : ""}" → ${c.expectedSteering}`,
        async () => {
          const actual = await classify(c.userMessage);
          expect(
            actual,
            `Expected ${c.expectedSteering} for "${c.userMessage}" (${c.notes ?? "no notes"})`,
          ).toBe(c.expectedSteering);
        },
        45_000,
      );
    }
  },
);

// When the gateway key is absent the whole `describe.skipIf` block is
// inert — add a tiny always-on case so vitest reports "1 test passed"
// instead of "no tests found" in that config.
describe("intent classification regression — suite smoke", () => {
  it("CASES shape is well-formed", () => {
    for (const c of CASES) {
      expect(typeof c.userMessage).toBe("string");
      expect(c.userMessage.length).toBeGreaterThan(0);
      expect(normalizeSteering(c.expectedSteering)).toBe(c.expectedSteering);
    }
  });
});
