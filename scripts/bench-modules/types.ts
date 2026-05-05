/**
 * /bench-modules — types.
 *
 * Mirrors `bench-intent` shape but for the per-module pipeline.
 * Per proposal §4 + §6: every module ships with bench fixtures that exercise
 * its observable behavior under live LLM calls. Drift between expected and
 * actual surfaces immediately; no manual eyeballing.
 *
 * PR1a ships harness scaffolding only — no rule fixtures. PR1c adds the
 * six rule-module fixtures (validated on the spike branch
 * `wip/composer-modules-spike`, 6/6 PASS, 2026-05-04).
 */
import type {
  ActionRequest,
  ComposerInvoker,
  IntentSurface,
  MatchResult,
  ModuleContext,
  ModuleGuardRecord,
} from "@/agent/modules/types";

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

/** Expected action emission. paramsContains is a partial — checks subset of fields. */
export interface ExpectedAction {
  action: string;
  paramsContains?: Record<string, unknown>;
  paramsNotContains?: string[];                 // keys that must be absent (or with disallowed values)
}

/** Expected guard firing. Matches by guard name; phase optional. */
export interface ExpectedGuardFire {
  name: string;
  phase?: "preEmit" | "postStream";
}

export interface ModuleFixture {
  /** Stable name for the fixture (used in bench output). */
  name: string;
  /** Free-text description: what behavior this fixture validates. */
  description: string;
  /** Module to invoke. */
  surface: IntentSurface;
  intent: string;
  /** ModuleContext to feed the runner (synthetic — no real DB hits). */
  moduleContext: ModuleContext;
  /** MatchResult to feed the runner. */
  matchResult: MatchResult;
  /** Current user message. */
  userMessage: string;
  /** Conversation history before the user message. */
  conversationHistory: Array<{ role: string; content: string }>;
  /**
   * Multi-turn host/assistant turns to run sequentially BEFORE the
   * `userMessage` turn under test. Each entry is one host turn; the bench
   * harness invokes runModule per turn, threading the assistant's prior
   * response into `conversationHistory` so the final turn (userMessage) sees
   * the same on-the-wire history a real session would.
   *
   * Per Rule 27 (proposal §4.2) — bench fixtures need to express
   * "host says X, you reply, then host says Y" patterns that previously
   * lived as multi-turn worked dialogues in the operational fragments.
   * The harness implementation (per-turn replay) lives in `run.ts`.
   *
   * Optional. Single-turn fixtures leave this undefined.
   */
  priorTurns?: Array<{ host: string; expectedAssistant?: string }>;
  /**
   * Optional composer invoker override (for synthetic-injection fixtures).
   * Production fixtures omit this; the runner uses `defaultComposerInvoker`
   * which calls live Sonnet.
   */
  composerInvoker?: ComposerInvoker;
  /** Expectations the bench checks against the runner's output. */
  expected: {
    /** Expected action emissions. Each must match by name + paramsContains. */
    actions?: ExpectedAction[];
    /** Action emissions that must NOT appear (e.g., never emit `update` with fabricated id). */
    actionsNotEmitted?: string[];
    /** Substrings that MUST appear in the prose response (case-insensitive). */
    proseContains?: string[];
    /** Substrings that MUST NOT appear in the prose. */
    proseNotContains?: string[];
    /**
     * Good/bad narration assertions (proposal §4.2). Each entry is a single
     * concept being tested ("narration scope: Friday only"). The assertion
     * passes when:
     *   - every `goodPhrase` appears in the prose (case-insensitive), AND
     *   - no `badPhrase` appears.
     * The migrated good/bad pairs from operational fragments land here as
     * regression assertions — moving from "show-and-tell in prompt" to
     * "fail-on-match in bench."
     *
     * Example: `{ concept: "narration scope", goodPhrases: ["Friday"],
     *            badPhrases: ["Thursday"] }` for a Friday-only request.
     */
    goodBadPairs?: Array<{
      concept: string;
      goodPhrases?: string[];
      badPhrases?: string[];
    }>;
    /** Guards that must fire. */
    guardsFired?: ExpectedGuardFire[];
    /** Guards that must NOT fire (e.g., happy-path: no fabricatedIdCheck). */
    guardsNotFired?: string[];
    /** Did a retry happen? null = either ok. */
    retryHappened?: boolean | null;
    /** Did retries exhaust? */
    exhaustedRetries?: boolean;
    /** Did blocking-severity fallback prose ship? */
    blockingFallbackShipped?: boolean;
    /** Tool calls expected (subset; can be empty). */
    toolsCalled?: string[];
    /** Tools that must NOT be called. */
    toolsNotCalled?: string[];
  };
}

// ---------------------------------------------------------------------------
// Bench result types
// ---------------------------------------------------------------------------

export interface FixtureResult {
  fixture: string;
  description: string;
  passed: boolean;
  failures: string[];
  /** Captured runner output (truncated for display). */
  capturedText: string;
  capturedActions: ActionRequest[];
  moduleGuard: ModuleGuardRecord;
  systemPromptHash: string;                     // sha-1 of system prompt for change-detection
  systemPromptLen: number;
  durationMs: number;
}

export interface BenchSummary {
  total: number;
  passed: number;
  failed: number;
  timestampIso: string;
  modulesUnderTest: string[];                   // e.g., ["dashboard-host/rule"]
}

export interface BenchOutput {
  summary: BenchSummary;
  results: FixtureResult[];
}
