/**
 * Playbook variant selector for the `chat` module.
 *
 * Per `2026-05-05_conversational-onboarding-vision_decided-2026-05-05` §3.3
 * (PR-C). The chat cluster is the dashboard-host fall-through bucket; most
 * turns route to `base` (the existing `calendar-event-composer.md` fragment).
 * The post-calibration variant fires when the host is within 5 minutes of a
 * recalibrate-arc terminal completion (or, for legacy users mid-deterministic
 * flow auto-resume, a `primary-link-tuning` terminal completion).
 *
 * Per Author Response B3 (the chip-fallback removal): there is NO "back to
 * deterministic flow" chip in any chat variant.
 *
 * Per Author Response B2 (sub-dormant): no chat-module variant for the 8–13d
 * sub-dormant return in v1 (chat-resident framing only); PR-D will add the
 * `sub-dormant-return` variant.
 *
 * Variant resolution:
 *   "post-calibration" — `lastCalibrationCompletionAt` (or, fallback for
 *                        legacy auto-resume, `lastTuningCompletionAt`)
 *                        within `POST_CALIBRATION_WINDOW_MS` of the current
 *                        turn's `now`. Highest priority — it wins even if
 *                        the matcher set a different `playbookVariant`.
 *   "base"            — fallthrough; uses the existing
 *                        `calendar-event-composer.md` fragment.
 */
import type { MatchResult, ModuleContextOutput } from "@/agent/modules/types";
import type { OnboardingState } from "@/lib/onboarding/dormant-eligibility";

export type ChatVariant = "post-calibration" | "base";

/** 5-minute window per proposal §3.3. Exposed for tests. */
export const POST_CALIBRATION_WINDOW_MS = 5 * 60 * 1000;

interface ScheduleContextLike extends ModuleContextOutput {
  onboardingState?: OnboardingState;
}

/**
 * Decide whether `post-calibration` should fire on this turn.
 *
 * Considers both `lastCalibrationCompletionAt` (recalibrate-arc completion —
 * the canonical post-conversational-onboarding signal) AND
 * `lastTuningCompletionAt` (legacy deterministic PrimaryLinkFlow terminal).
 * Per the author's note in the PR-C spec: the legacy path's auto-resumed
 * users still benefit from post-calibration framing on their first turn back
 * to chat after completion, so both timestamps qualify within the window.
 *
 * `now` is injectable for tests; defaults to wall-clock.
 */
export function selectChatVariant(
  // matchResult unused in v1 — chat doesn't expose any matcher-stamped
  // playbookVariant for v1. Kept on the signature for future-compat with
  // the recalibrate `selectVariant(matchResult, contextOutput)` shape.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _matchResult: MatchResult,
  contextOutput: ScheduleContextLike,
  now: Date = new Date(),
): ChatVariant {
  const state = contextOutput.onboardingState;
  if (!state) return "base";

  const candidates: Array<Date | null> = [
    state.lastCalibrationCompletionAt,
    state.lastTuningCompletionAt,
  ];
  for (const at of candidates) {
    if (!at) continue;
    const delta = now.getTime() - at.getTime();
    if (delta >= 0 && delta <= POST_CALIBRATION_WINDOW_MS) {
      return "post-calibration";
    }
  }
  return "base";
}

/**
 * Map a variant to its composer playbook fragments. Mirrors the recalibrate
 * module's `fragmentPathForVariant` shape. The `base` variant returns the
 * historical chat playbook (`fragments/voice` + `calendar-event-composer`)
 * unchanged so non-onboarding paths are byte-identical to the pre-PR-C
 * system prompt.
 */
export function playbookForVariant(variant: ChatVariant): readonly string[] {
  switch (variant) {
    case "post-calibration":
      return [
        "fragments/voice",
        "composers/calendar-event-composer",
        "composers/chat/post-calibration",
      ];
    case "base":
      return ["fragments/voice", "composers/calendar-event-composer"];
  }
}
