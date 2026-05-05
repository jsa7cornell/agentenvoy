/**
 * Command-to-state integration test harness.
 *
 * Pattern: "user types message X → after the channel turn runs end-to-end →
 * database state is Y." Distinct from existing API integration tests, which
 * test endpoints, not full conversational round-trips.
 *
 * Why this exists
 * ---------------
 * State-integrity bugs surfaced in production on 2026-05-05 because no test
 * asserts "after the user says 'Protect next Tuesday all day',
 * `User.preferences.compiled.blockedWindows` contains a single date-scoped
 * entry and nothing else." If that test had existed, today's rule-compiler
 * bug couldn't have shipped. Hundreds of bench fixtures exist on prompt
 * behavior; almost zero command→state assertions.
 *
 * Cross-references: meta-proposal
 * `proposals/2026-05-05_state-integrity-and-architectural-attention-bias.md`.
 *
 * Pragmatic compromise re. "end-to-end"
 * --------------------------------------
 * The full channel-chat handler at `src/app/api/channel/chat/route.ts` calls
 * an LLM composer to emit `[ACTION]{...}[/ACTION]` blocks. Driving real LLM
 * traffic in a fast, deterministic integration test is impractical (slow,
 * flaky, requires API keys). So this harness drives the SERVER-SIDE half of
 * a turn: given the action sequence the composer would emit for a given
 * user message, run the same writer + compiler path that production runs.
 *
 * Concretely:
 *   parseActions(composerOutput) → executeActions(...)
 *
 * That's exactly the contract `route.ts` invokes. The harness then loads the
 * post-turn `User.preferences` row, runs `compileStructuredRules` exactly as
 * the read-side does (e.g. tuner-preferences GET), and returns the materialized
 * compiled state for assertion.
 *
 * This means: this harness validates "the writer + compiler pipeline given
 * the composer's emit." A future Phase 2 could plug in a real LLM call to
 * also validate that the composer emits the right [ACTION] blocks for a
 * given utterance — but that's a separate axis of risk and lives in the
 * eval/bench infrastructure today.
 *
 * Safety
 * ------
 * Reuses the existing post-prod-wipe triple-guard at
 * `src/__tests__/integration/helpers/safety.ts`. Hard-fails if the test DB
 * isn't local. Never builds a parallel safety mechanism. See post-mortem
 * 2026-05-04.
 */

import type { Prisma, User } from "@prisma/client";
import {
  executeActions,
  parseActions,
  type ActionRequest,
  type ActionResult,
} from "@/agent/actions";
import {
  compileStructuredRules,
  type AvailabilityPreference,
} from "@/lib/availability-rules";
import type { CompiledRules, UserPreferences } from "@/lib/scoring";
import { prisma } from "../helpers/db";
import { assertSafeIntegrationDb } from "../helpers/safety";

/** A single command-to-state turn, in either of two input shapes. */
export interface RunTurnInput {
  /** The host user whose turn this is. */
  userId: string;
  /** The user's original utterance. Recorded in telemetry; not used for routing. */
  userMessage: string;
  /**
   * Either the raw composer output containing `[ACTION]...[/ACTION]` blocks
   * (preferred — exercises the parser too), or a pre-parsed action list.
   * One of these two MUST be provided.
   */
  composerOutput?: string;
  actions?: ActionRequest[];
}

/**
 * What `runTurn` returns. The shape is deliberately broad — tests assert
 * over `preferences`, `structuredRules`, and `compiled` directly.
 */
export interface TurnResult {
  /** Per-action outcomes, in dispatch order. */
  actionResults: ActionResult[];
  /** Post-turn `User` row (full select, refreshed from DB). */
  user: User;
  /** Convenience: `user.preferences as UserPreferences`. Null if unset. */
  preferences: UserPreferences | null;
  /** Convenience: `preferences.explicit.structuredRules ?? []`. */
  structuredRules: AvailabilityPreference[];
  /**
   * Compiled rules — recomputed from active structuredRules using the same
   * `compileStructuredRules` the tuner-preferences GET route uses.
   *
   * Note: `User.preferences.compiled` is currently materialized lazily on
   * tuner GET, not on rule write. Tests should assert against THIS field
   * (the freshly-compiled view) — that's what every read site sees.
   */
  compiled: CompiledRules;
  /** The original user message, echoed for telemetry. */
  userMessage: string;
  /** Parsed actions that ran (after composerOutput parsing, if any). */
  actionsRan: ActionRequest[];
}

/**
 * Seed a clean test user with known initial preferences. Idempotent on
 * email — call as many times as needed across a single test (each test's
 * `beforeEach(resetDb)` wipes it back to zero).
 */
export async function seedTestUser(
  overrides: Partial<{
    email: string;
    name: string;
    meetSlug: string;
    timezone: string;
    structuredRules: AvailabilityPreference[];
    businessHoursStart: number;
    businessHoursEnd: number;
  }> = {},
): Promise<User> {
  const email = overrides.email ?? `command-to-state+${Date.now()}@agentenvoy.test`;
  const meetSlug = overrides.meetSlug ?? `c2s-${Math.random().toString(36).slice(2, 8)}`;
  const timezone = overrides.timezone ?? "America/Los_Angeles";

  const explicit: Record<string, unknown> = {
    timezone,
    businessHoursStart: overrides.businessHoursStart ?? 9,
    businessHoursEnd: overrides.businessHoursEnd ?? 18,
    structuredRules: overrides.structuredRules ?? [],
  };

  const preferences: Prisma.InputJsonValue = {
    explicit,
  } as Prisma.InputJsonValue;

  return prisma.user.upsert({
    where: { email },
    update: { preferences, meetSlug },
    create: {
      email,
      name: overrides.name ?? "Command-to-State Fixture",
      meetSlug,
      preferences,
    },
  });
}

/**
 * Drive a single command-to-state turn end-to-end.
 *
 * Resolves the action sequence (either parsing `composerOutput` or using
 * `actions` directly), runs `executeActions` against the real DB, then
 * reloads the user row and recompiles structured rules so callers can
 * assert over the post-turn state.
 *
 * Hard-fails early if the test DB isn't local — defense in depth on top of
 * the global guard that already runs in `globalSetup`.
 */
export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  // Belt-and-braces: per-call gate. Cheap; refuses if a future caller
  // imports this harness from a non-integration context.
  assertSafeIntegrationDb();

  if (!input.composerOutput && !input.actions) {
    throw new Error(
      "[command-to-state harness] runTurn requires either `composerOutput` or `actions`.",
    );
  }

  const actions: ActionRequest[] = input.actions
    ? input.actions
    : parseActions(input.composerOutput ?? "");

  const actionResults = await executeActions(actions, input.userId);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
  });

  const preferences = (user.preferences as UserPreferences | null) ?? null;
  const explicit =
    (preferences?.explicit as Record<string, unknown> | undefined) ?? {};
  const structuredRules =
    ((explicit as Record<string, unknown>).structuredRules as
      | AvailabilityPreference[]
      | undefined) ?? [];

  const bizStart = (explicit.businessHoursStart as number) ?? 9;
  const bizEnd = (explicit.businessHoursEnd as number) ?? 18;
  const activeRules = structuredRules.filter((r) => r.status === "active");
  const compiled = compileStructuredRules(activeRules, bizStart, bizEnd);

  return {
    actionResults,
    user,
    preferences,
    structuredRules,
    compiled,
    userMessage: input.userMessage,
    actionsRan: actions,
  };
}

/**
 * Compute "next Tuesday" relative to a reference date, returning an ISO
 * date string ("YYYY-MM-DD"). If `from` already IS a Tuesday, returns the
 * Tuesday seven days later (matches "next Tuesday" colloquially — never
 * today).
 *
 * Pure utility — used by tests to build expected effectiveDate without
 * coupling assertions to wall-clock time.
 */
export function nextTuesdayISO(from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  // 0=Sun..6=Sat. Tuesday = 2.
  const day = d.getUTCDay();
  const daysUntil = day === 2 ? 7 : (2 - day + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntil);
  return d.toISOString().slice(0, 10);
}
