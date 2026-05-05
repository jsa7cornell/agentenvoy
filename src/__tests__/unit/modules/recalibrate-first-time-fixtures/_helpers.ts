/**
 * Shared helpers for the PR-D recalibrate `first-time` bench fixtures.
 *
 * Synthetic inputs to `requiredFieldExtractionCheck` (PR-A's multi-action-emit
 * fidelity guard). No LLM calls, no DB. Pattern mirrors the existing
 * `recalibrate-module.test.ts` (mocked LLM, deterministic predicate-shape
 * assertions).
 *
 * Per proposal `2026-05-05_conversational-onboarding-vision_decided-2026-05-05`
 * Author Response B4 — these are the bench-fixture floor for the
 * multi-action-emit shape.
 */
import type { ActionRequest } from "@/agent/actions";
import type { ModuleContext } from "@/agent/modules/types";
import type { RecalibrateContext } from "@/agent/modules/recalibrate/context-loader";

const TEST_USER = {
  id: "test-host-1",
  name: "John",
  email: "john@example.com",
};

const TEST_CHANNEL = { id: "test-channel-1" };

/** Minimal `ModuleContext` stub for `dashboard-host`. The check only reads
 *  `moduleContext.surface`; all other fields are unused. */
export function makeModuleContext(): ModuleContext {
  return {
    user: TEST_USER,
    channel: TEST_CHANNEL,
    surface: "dashboard-host",
  } as ModuleContext;
}

/** Build a minimal `RecalibrateContext` with the fields the check reads
 *  (`currentUserMessage`, `isFirstTime`). Other fields are filled with
 *  benign defaults so the type-check passes. */
export function makeFirstTimeContext(
  currentUserMessage: string,
): RecalibrateContext {
  return {
    contextLines: [],
    groundTruthBlock: "",
    daysSinceCalibration: 0,
    driftAnalysis: {
      daysSinceCalibration: 0,
      timezoneDrifted: false,
      durationDrifted: false,
      hoursDrifted: false,
      newCalendarsAvailable: 0,
      googleTimezone: null,
      storedTimezone: null,
      googleDuration: null,
      storedDuration: null,
    },
    profileGaps: [],
    recentMeetingPattern: { medianDurationLast30Days: null, overrideCount: 0 },
    isFirstTime: true,
    currentUserMessage,
  };
}

/** Compact ActionRequest constructor. */
export function action(
  name: string,
  params: Record<string, unknown>,
): ActionRequest {
  return { action: name, params };
}
