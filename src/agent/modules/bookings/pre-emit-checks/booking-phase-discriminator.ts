/**
 * `booking-phase-discriminator` — pre-emit check for the bookings module.
 *
 * Guards against the composer skipping Phase 1 and calling
 * `book_time_with_commit` before ever running `resolve_contact` or
 * `intersect_availability` in the SAME turn.
 *
 * The composer's system prompt already forbids this ("Never skip Phase 1"),
 * but deterministic enforcement here ensures a guard fires and forces a retry
 * rather than silently minting a booking with an unvalidated slot.
 *
 * Detection heuristic: if `parsedActions` contains a `book_time_with_commit`
 * action AND the contextOutput has no prior `intersect_availability` call in
 * this turn, flag it as blocking.
 *
 * NOTE: The "prior call" signal is passed via `contextOutput.__toolCallLog` —
 * the runner populates this field after each tool execution within a turn (see
 * runner.ts §"tool-call logging"). The check is intentionally lenient: if
 * `__toolCallLog` is absent (e.g., in tests that don't inject it), the check
 * passes (opt-in strictness).
 *
 * Per handoff doc §"Pre-emit checks" + PR4 proposal §4.2 scenario F.
 */
import type {
  PreEmitCheck,
  PreEmitCheckArgs,
  PreEmitCheckResult,
} from "@/agent/modules/types";
import type { BookingsContext } from "../context-loader";

export const bookingPhaseDiscriminator: PreEmitCheck<BookingsContext> = {
  name: "booking-phase-discriminator",
  severity: "blocking",

  check: async (
    args: PreEmitCheckArgs<BookingsContext>,
  ): Promise<PreEmitCheckResult | null> => {
    const { parsedActions, contextOutput } = args;

    // Only relevant if a commit action was emitted.
    const hasCommit = parsedActions.some(
      (a) => a.action === "book_time_with_commit",
    );
    if (!hasCommit) return null;

    // If the runner injected a tool-call log, verify Phase 1 ran.
    const toolCallLog = (
      contextOutput as BookingsContext & {
        __toolCallLog?: string[];
      }
    ).__toolCallLog;

    if (toolCallLog !== undefined) {
      const ranIntersect = toolCallLog.includes("intersect_availability");
      if (!ranIntersect) {
        return {
          flaggedReason:
            "booking-phase-discriminator: book_time_with_commit emitted without intersect_availability in this turn",
          hint:
            "You must call resolve_contact then intersect_availability to get candidate slots, " +
            "present them to the host, wait for their choice, and ONLY THEN call book_time_with_commit. " +
            "Start over from Phase 1.",
          fallbackProse:
            "I hit a scheduling guard — please rephrase who you'd like to meet and I'll walk through finding a time.",
        };
      }
    }

    return null;
  },
};
