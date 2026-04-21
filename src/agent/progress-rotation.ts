import type { ProgressStage, ProgressCopyInterpolation } from "./progress-copy";

/**
 * Within-stage variant rotation interval (proposal §2.2 R2 fold). Fires only
 * during the long-running stages (scanning-calendar, thinking) so slow turns
 * show cosmetic movement. Per-frame dedup + overall cap are enforced by the
 * emitter passed in — not here.
 */
export const WITHIN_STAGE_ROTATION_MS = 1800;

export type StageEmitter = (
  stage: ProgressStage,
  options: { slots?: ProgressCopyInterpolation; withinStageIndex?: number },
) => boolean;

/**
 * Wraps a long-running async operation with within-stage variant rotation.
 * Emits the initial status frame, then ticks every `intervalMs` to call the
 * emitter again with an incremented withinStageIndex. Stops ticking as soon
 * as the emitter returns false (cap hit or no fresh variants). The interval
 * is always cleared — operation errors propagate intact.
 */
export async function runWithStageRotation<T>(
  emit: StageEmitter,
  stage: ProgressStage,
  operation: () => Promise<T>,
  options: { slots?: ProgressCopyInterpolation; intervalMs?: number } = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? WITHIN_STAGE_ROTATION_MS;
  let tickIndex = 1;
  const initial = emit(stage, { slots: options.slots, withinStageIndex: 0 });
  let interval: ReturnType<typeof setInterval> | null = null;
  if (initial) {
    interval = setInterval(() => {
      const ok = emit(stage, {
        slots: options.slots,
        withinStageIndex: tickIndex,
      });
      tickIndex += 1;
      if (!ok && interval) {
        clearInterval(interval);
        interval = null;
      }
    }, intervalMs);
  }
  try {
    return await operation();
  } finally {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }
}
