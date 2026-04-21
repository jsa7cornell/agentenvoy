import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithStageRotation } from "@/agent/progress-rotation";
import type { ProgressStage, ProgressCopyInterpolation } from "@/agent/progress-copy";

type EmitCall = {
  stage: ProgressStage;
  withinStageIndex: number | undefined;
  slots: ProgressCopyInterpolation | undefined;
};

function makeEmitter(capResponses: boolean[] = []) {
  const calls: EmitCall[] = [];
  let callIndex = 0;
  const emit = (
    stage: ProgressStage,
    options: { slots?: ProgressCopyInterpolation; withinStageIndex?: number },
  ): boolean => {
    calls.push({
      stage,
      withinStageIndex: options.withinStageIndex,
      slots: options.slots,
    });
    const response =
      callIndex < capResponses.length ? capResponses[callIndex] : true;
    callIndex += 1;
    return response;
  };
  return { emit, calls };
}

describe("runWithStageRotation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the initial frame and rotates while the operation is pending", async () => {
    const { emit, calls } = makeEmitter();
    let resolveOp: (value: string) => void = () => {};
    const opPromise = new Promise<string>((r) => {
      resolveOp = r;
    });

    const run = runWithStageRotation(emit, "thinking", () => opPromise, {
      intervalMs: 100,
    });

    // Initial emit happens synchronously.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ stage: "thinking", withinStageIndex: 0 });

    // Advance 250ms → expect 2 rotation ticks.
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toHaveLength(3);
    expect(calls[1].withinStageIndex).toBe(1);
    expect(calls[2].withinStageIndex).toBe(2);

    resolveOp("done");
    await expect(run).resolves.toBe("done");

    // After the operation completes, no further ticks fire.
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(3);
  });

  it("stops ticking when emit returns false (cap exceeded)", async () => {
    // First emit ok, second emit ok, third emit false → interval clears.
    const { emit, calls } = makeEmitter([true, true, false]);
    let resolveOp: () => void = () => {};
    const opPromise = new Promise<void>((r) => {
      resolveOp = r;
    });

    const run = runWithStageRotation(emit, "scanning-calendar", () => opPromise, {
      intervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(3);
    // Third returned false → no more ticks even as time passes.
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(3);

    resolveOp();
    await run;
  });

  it("clears the interval when the operation throws", async () => {
    const { emit, calls } = makeEmitter();
    const run = runWithStageRotation(
      emit,
      "thinking",
      () => Promise.reject(new Error("boom")),
      { intervalMs: 100 },
    );

    await expect(run).rejects.toThrow("boom");

    // No ticks should fire after rejection, even as time passes.
    const countAfterReject = calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(countAfterReject);
  });

  it("skips setting up the interval if the initial emit returns false", async () => {
    const { emit, calls } = makeEmitter([false]);
    const run = runWithStageRotation(emit, "thinking", () => Promise.resolve(42), {
      intervalMs: 100,
    });

    await expect(run).resolves.toBe(42);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
  });

  it("forwards slots to every emission", async () => {
    const { emit, calls } = makeEmitter();
    let resolveOp: () => void = () => {};
    const opPromise = new Promise<void>((r) => {
      resolveOp = r;
    });

    const slots = { tz: "ET" } as ProgressCopyInterpolation;
    const run = runWithStageRotation(emit, "scanning-calendar", () => opPromise, {
      intervalMs: 100,
      slots,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(calls.every((c) => c.slots === slots)).toBe(true);

    resolveOp();
    await run;
  });
});
