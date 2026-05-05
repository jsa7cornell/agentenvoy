/**
 * Rule module bench fixtures — six scenarios per the spike-and-bench plan.
 *
 * Each fixture validates one or more of the four LLM-behavior assumptions:
 *   1. Fragmented playbooks vs flat (composer reads multi-fragment system prompt)
 *   2. [GROUND TRUTH] CURRENT RULES block actually used (real ids, no fabrication)
 *   3. composerTools adoption (check_conflicts_for_rule called when appropriate)
 *   4. Retry-of-retry convergence (guard fires + retry produces correct emission)
 *
 * Run:
 *   op run --env-file=.env.tpl -- npx tsx scripts/bench-modules/run.ts
 *   op run --env-file=.env.tpl -- npx tsx scripts/bench-modules/run.ts --name=F14
 */
import type { ModuleContext } from "@/agent/modules/types";
import type { RuleSummary, UpcomingEvent } from "@/agent/modules/rule/context-loader";
import type { ModuleFixture } from "../types";

// ---------------------------------------------------------------------------
// Synthetic ModuleContext shapes (with spike side-channel injection fields)
// ---------------------------------------------------------------------------

interface TestRuleContext extends ModuleContext {
  __testRecentRules?: RuleSummary[];
  __testUpcomingEvents?: UpcomingEvent[];
  __testPrimaryDefaults?: { format: string; duration: number; hours: string };
}

const TEST_USER = {
  id: "test-host-1",
  name: "John",
  email: "john@example.com",
};

const TEST_CHANNEL = { id: "test-channel-1" };

// Helpers — generate ISO datetimes for upcoming Tuesdays at 2pm local.
function upcomingTuesdays2pm(count: number): UpcomingEvent[] {
  const out: UpcomingEvent[] = [];
  const now = new Date();
  let cursor = new Date(now);
  // Advance to next Tuesday
  while (cursor.getDay() !== 2) cursor.setDate(cursor.getDate() + 1);
  for (let i = 0; i < count; i++) {
    const start = new Date(cursor);
    start.setHours(14, 0, 0, 0);
    const end = new Date(start);
    end.setHours(14, 30);
    out.push({
      summary: `Confirmed Tuesday 2pm meeting #${i + 1}`,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    });
    cursor.setDate(cursor.getDate() + 7);
  }
  return out;
}

// Existing rule for "Sales pitch" — used for fixture 6 (update existing rule).
const SALES_PITCH_RULE: RuleSummary = {
  id: "rule_a3b9c2d1",
  name: "Sales pitch",
  type: "recurring",
  action: "bookable",
  daysOfWeek: [2, 4],                            // Tue + Thu
  timeStart: "14:00",
  timeEnd: "16:00",
};

// ---------------------------------------------------------------------------
// Fixture 1 — F14 reproduction (the bug-trigger transcript)
// ---------------------------------------------------------------------------

/**
 * Tests assumptions 1 + 2: fragmented playbook + [GROUND TRUTH] block.
 * Sales Discovery thread followed by a Coaching prefill.
 *
 * Per the calendar-rule-composer.md HARD RULE ("never auto-create" on Turn 1
 * for bookable rules), Turn 1 is propose-only — composer asks for confirmation
 * before emitting. Real F14 validation:
 *   - No fabricated id (M1 fixed)
 *   - No scrambled emission (M2 fixed)
 *   - Coaching params (45-min) referenced correctly, not contaminated by
 *     Sales Discovery's 60-min from the prior thread
 *
 * Full F14 M2 round-trip would be a Turn 2 test ("yes, looks good" → emit
 * with Coaching params not Sales Discovery params). Spike scopes to Turn 1;
 * the bench harness can be extended to multi-turn fixtures later.
 */
export const fixture1_F14_reproduction: ModuleFixture = {
  name: "F14_reproduction",
  description:
    "F14 trigger transcript Turn 1 — Sales Discovery thread + 'Create a recurring coaching bookable link — 45 min, weekly' prefill. " +
    "Per HARD RULE, Turn 1 is propose-only. Composer should NOT fabricate id, NOT emit a scrambled add, AND mention Coaching with 45-min not 60-min.",
  surface: "dashboard-host",
  intent: "rule",
  moduleContext: {
    user: TEST_USER,
    channel: TEST_CHANNEL,
    surface: "dashboard-host",
    __testRecentRules: [],                      // host has no rules yet
    __testUpcomingEvents: [],
    __testPrimaryDefaults: { format: "video", duration: 30, hours: "9:00-17:00" },
  } as TestRuleContext,
  matchResult: {
    kind: "deterministic",
    resolved: { freshCreate: true },
    playbookVariant: "add",
  },
  userMessage: "Create a recurring coaching bookable link — 45 min, weekly",
  conversationHistory: [
    // Synthetic Sales Discovery thread — leak surface for cross-thread param scramble.
    { role: "user", content: "I want to set up a Sales Discovery bookable link." },
    {
      role: "envoy",
      content:
        "Got it — Sales Discovery sounds like a recurring weekday window. Want to confirm: 30-min video calls weekdays 9-5, or different?",
    },
    { role: "user", content: "instead lets make it 1 hour, VC" },
    {
      role: "envoy",
      content:
        "Got it — updating to 60-minute video calls. Want the window to stay weekdays 9–5?",
    },
  ],
  expected: {
    // Turn 1: propose-only per the HARD RULE. No action emission expected.
    actionsNotEmitted: ["update_availability_rule"],
    // The composer should mention "Coaching" + "45" (the new ask's params, not contaminated).
    proseContains: ["Coaching", "45"],
    // No fabricated id — neither the literal word "general" as an id nor an `update` operation.
    // (composer might mention "general" in other prose contexts, so this check is loose.)
    guardsNotFired: ["fabricated-id-check"],     // never had a chance to fire — no action emitted
    retryHappened: false,
    blockingFallbackShipped: false,
  },
};

// ---------------------------------------------------------------------------
// Fixture 2 — F14 with composer drift (synthetic injection)
// ---------------------------------------------------------------------------

/**
 * Tests assumption 4: retry convergence on fabricatedIdCheck.
 * Synthetic LLM override returns the F14-shape fabricated-id emission on the
 * first call; the second call (after the retry hint) returns the correct
 * `add` action. Expected: `fabricatedIdCheck` fires, retry succeeds, second
 * emission is correct.
 */
export const fixture2_F14_drift_retry: ModuleFixture = {
  name: "F14_drift_retry",
  description:
    "Synthetic injection: composer's first emission is F14-shape (fabricated id:'general'). " +
    "Verifies fabricatedIdCheck fires + retry hint produces a correct operation:'add' emission.",
  surface: "dashboard-host",
  intent: "rule",
  moduleContext: {
    user: TEST_USER,
    channel: TEST_CHANNEL,
    surface: "dashboard-host",
    __testRecentRules: [],
    __testUpcomingEvents: [],
    __testPrimaryDefaults: { format: "video", duration: 30, hours: "9:00-17:00" },
  } as TestRuleContext,
  matchResult: { kind: "deterministic", resolved: { freshCreate: true }, playbookVariant: "add" },
  userMessage: "Create a recurring coaching bookable link — 45 min, weekly",
  conversationHistory: [],
  composerInvoker: (() => {
    let callCount = 0;
    return async () => {
      callCount += 1;
      if (callCount === 1) {
        // F14-shape emission: fabricated id, wrong operation
        return {
          text: `Sounds good — setting up your Coaching bookable link.

[ACTION]{"action":"update_availability_rule","params":{"operation":"update","id":"general","rule":{"type":"recurring","action":"bookable","timeStart":"09:00","timeEnd":"17:00","daysOfWeek":[1,2,3,4,5],"bookable":{"name":"Coaching","format":"video","durationMinutes":45},"originalText":"Create a recurring coaching bookable link — 45 min, weekly"}}}[/ACTION]`,
        };
      }
      // Retry: corrected emission
      return {
        text: `Your **Coaching** bookable link is live. Let me know if you want to change anything.

[ACTION]{"action":"update_availability_rule","params":{"operation":"add","rule":{"type":"recurring","action":"bookable","timeStart":"09:00","timeEnd":"17:00","daysOfWeek":[1,2,3,4,5],"bookable":{"name":"Coaching","format":"video","durationMinutes":45},"originalText":"Create a recurring coaching bookable link — 45 min, weekly"}}}[/ACTION]`,
      };
    };
  })(),
  expected: {
    actions: [
      { action: "update_availability_rule", paramsContains: { operation: "add" } },
    ],
    actionsNotEmitted: [],
    guardsFired: [{ name: "fabricated-id-check", phase: "preEmit" }],
    retryHappened: true,
    exhaustedRetries: false,
    blockingFallbackShipped: false,
  },
};

// ---------------------------------------------------------------------------
// Fixture 3 — Conflict-awareness happy path (composer calls the tool)
// ---------------------------------------------------------------------------

/**
 * Tests assumption 3: composer adopts check_conflicts_for_rule.
 * Host says "block 2pm every Tuesday" with 8 confirmed Tuesday 2pm meetings.
 * Expected: composer calls `check_conflicts_for_rule` AND narrates the
 * shadow count. `conflictAwarenessGuard` should NOT need to fire because
 * the composer already surfaced the conflicts.
 */
export const fixture3_conflict_awareness_happy: ModuleFixture = {
  name: "conflict_awareness_happy",
  description:
    "Host says 'block 2pm every Tuesday' with 8 confirmed Tuesday 2pm meetings. " +
    "Composer should call check_conflicts_for_rule and narrate the conflicts; should not emit immediately without surfacing.",
  surface: "dashboard-host",
  intent: "rule",
  moduleContext: {
    user: TEST_USER,
    channel: TEST_CHANNEL,
    surface: "dashboard-host",
    __testRecentRules: [],
    __testUpcomingEvents: upcomingTuesdays2pm(8),
    __testPrimaryDefaults: { format: "video", duration: 30, hours: "9:00-17:00" },
  } as TestRuleContext,
  matchResult: { kind: "deterministic", resolved: { freshCreate: true }, playbookVariant: "add" },
  userMessage: "Block 2pm every Tuesday — I need that hour for deep work going forward.",
  conversationHistory: [],
  expected: {
    // EITHER (a) composer calls the tool + asks for confirmation (no action emitted yet) → preferred
    // OR (b) composer emits but narrates the conflict (proseContains "shadow"|"conflict"|"block")
    // We test (a) with toolsCalled and proseContains markers; if (a) doesn't happen, (b) is acceptable
    // but conflictAwarenessGuard might fire. We accept both as long as the host is informed.
    toolsCalled: ["check_conflicts_for_rule"],
    proseContains: ["8"],                         // mention the shadow count
    // Note: the composer SHOULD ask for confirmation rather than immediately emit; relaxed expectation.
  },
};

// ---------------------------------------------------------------------------
// Fixture 4 — Conflict-awareness with composer drift (skip tool, emit immediately)
// ---------------------------------------------------------------------------

/**
 * Tests assumption 4 + N3 blocking severity: synthetic injection where
 * composer skips the tool and emits a `block` rule directly (8 meetings
 * shadowed). Expected: `conflictAwarenessGuard` fires; both retries fail;
 * `severity: blocking` ships fallbackProse and skips action emission.
 */
export const fixture4_conflict_awareness_drift: ModuleFixture = {
  name: "conflict_awareness_drift",
  description:
    "Synthetic injection: composer skips check_conflicts_for_rule and emits a `block` rule directly " +
    "while 8 confirmed meetings would be shadowed. Verifies conflictAwarenessGuard fires, retries fail, " +
    "blocking-severity fallbackProse ships and action is suppressed.",
  surface: "dashboard-host",
  intent: "rule",
  moduleContext: {
    user: TEST_USER,
    channel: TEST_CHANNEL,
    surface: "dashboard-host",
    __testRecentRules: [],
    __testUpcomingEvents: upcomingTuesdays2pm(8),
    __testPrimaryDefaults: { format: "video", duration: 30, hours: "9:00-17:00" },
  } as TestRuleContext,
  matchResult: { kind: "deterministic", resolved: { freshCreate: true }, playbookVariant: "add" },
  userMessage: "Block 2pm every Tuesday for deep work.",
  conversationHistory: [],
  composerInvoker: (() => {
    let count = 0;
    const drifted = `Done — Tuesdays 2-3pm now blocked.

[ACTION]{"action":"update_availability_rule","params":{"operation":"add","rule":{"type":"recurring","action":"block","timeStart":"14:00","timeEnd":"15:00","daysOfWeek":[2],"originalText":"Block 2pm every Tuesday for deep work."}}}[/ACTION]`;
    return async () => {
      count += 1;
      // Always returns the drifted shape — the composer never adapts. Tests retry exhaustion.
      return { text: drifted };
    };
  })(),
  expected: {
    guardsFired: [{ name: "conflict-awareness-guard", phase: "preEmit" }],
    retryHappened: true,
    exhaustedRetries: true,
    blockingFallbackShipped: true,
    actionsNotEmitted: ["update_availability_rule"],          // action is suppressed
    proseContains: ["shadow"],                                  // fallback prose surfaces the shadow
  },
};

// ---------------------------------------------------------------------------
// Fixture 5 — Standard create no-conflict (regression)
// ---------------------------------------------------------------------------

/**
 * Tests regression: simple rule create with no conflicts should pass cleanly.
 * No tool call needed (no shadowing); no guards fire; clean emission.
 */
export const fixture5_standard_create: ModuleFixture = {
  name: "standard_create",
  description:
    "Host says 'block lunch every weekday 12-1' with no calendar conflicts. " +
    "Composer should emit cleanly; no guards fire; behaviour matches today's legacy path.",
  surface: "dashboard-host",
  intent: "rule",
  moduleContext: {
    user: TEST_USER,
    channel: TEST_CHANNEL,
    surface: "dashboard-host",
    __testRecentRules: [],
    __testUpcomingEvents: [],                    // empty calendar — no conflicts
    __testPrimaryDefaults: { format: "video", duration: 30, hours: "9:00-17:00" },
  } as TestRuleContext,
  matchResult: { kind: "deterministic", resolved: { freshCreate: true }, playbookVariant: "add" },
  userMessage: "Block lunch every weekday 12-1.",
  conversationHistory: [],
  expected: {
    actions: [
      {
        action: "update_availability_rule",
        paramsContains: {
          operation: "add",
          rule: { action: "block", timeStart: "12:00", timeEnd: "13:00" },
        },
      },
    ],
    guardsNotFired: ["fabricated-id-check", "conflict-awareness-guard"],
    retryHappened: false,
    exhaustedRetries: false,
  },
};

// ---------------------------------------------------------------------------
// Fixture 6 — Update existing rule (composer reads [GROUND TRUTH] block)
// ---------------------------------------------------------------------------

/**
 * Tests assumption 2: composer reads [GROUND TRUTH] CURRENT RULES block and
 * uses real ids (not fabricated) for update operations.
 */
export const fixture6_update_existing: ModuleFixture = {
  name: "update_existing",
  description:
    "Host has rule_a3b9c2d1 'Sales pitch' in [GROUND TRUTH]. Says 'extend Sales pitch hours to Wednesday too.' " +
    "Composer should emit operation:'update' with id:'rule_a3b9c2d1' (real id, not fabricated).",
  surface: "dashboard-host",
  intent: "rule",
  moduleContext: {
    user: TEST_USER,
    channel: TEST_CHANNEL,
    surface: "dashboard-host",
    __testRecentRules: [SALES_PITCH_RULE],
    __testUpcomingEvents: [],
    __testPrimaryDefaults: { format: "video", duration: 30, hours: "9:00-17:00" },
  } as TestRuleContext,
  matchResult: {
    kind: "deterministic",
    resolved: { ruleId: "rule_a3b9c2d1" },
    playbookVariant: "update",
  },
  userMessage: "Extend Sales pitch hours to Wednesday too.",
  conversationHistory: [],
  expected: {
    actions: [
      {
        action: "update_availability_rule",
        paramsContains: {
          operation: "update",
          id: "rule_a3b9c2d1",                    // real id from [GROUND TRUTH] block
        },
      },
    ],
    actionsNotEmitted: [],
    guardsNotFired: ["fabricated-id-check"],      // composer reads ground-truth correctly
    retryHappened: false,
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const ruleFixtures: ModuleFixture[] = [
  fixture1_F14_reproduction,
  fixture2_F14_drift_retry,
  fixture3_conflict_awareness_happy,
  fixture4_conflict_awareness_drift,
  fixture5_standard_create,
  fixture6_update_existing,
];
