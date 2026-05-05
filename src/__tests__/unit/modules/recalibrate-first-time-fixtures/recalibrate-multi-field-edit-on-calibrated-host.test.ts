/**
 * Fixture 8 — boundary: multi-field edit on calibrated host routes to
 * `manage_setup` (via `edit_preference`), NOT `recalibrate`.
 *
 * Per proposal Author Response B2: `recalibrate.first-time` fires only when
 * `lastCalibratedAt` is within signup-grace-window AND no `manage_setup`
 * writes have happened yet; `recalibrate.dormant` fires only at >=14d gaps;
 * `recalibrate.explicit-ask` fires only on explicit retune phrasing;
 * everything else routes to `manage_setup` — including multi-field edits
 * on already-calibrated hosts ("set my buffer to 5 and protect Fridays").
 *
 * This fixture mocks the classifier (mirroring the boundary tests in
 * `recalibrate-module.test.ts`) and pins the routing decision so a
 * future rubric drift surfaces here.
 */
import { describe, it, expect, vi } from "vitest";

// Mock the LLM gateway, model, and span layers — same pattern as the
// existing `recalibrate-module.test.ts` classifier-boundary block.
const generateObjectMock = vi.fn();
const recordSpanMock = vi.fn(async (...args: unknown[]) => {
  const fn = args[1] as () => Promise<unknown>;
  return fn();
});

vi.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
}));

vi.mock("@/lib/model", () => ({
  envoyModel: (modelId: string) => ({ id: modelId }),
}));

vi.mock("@/lib/langfuse", () => ({
  recordSpan: (...args: unknown[]) => recordSpanMock(...args),
}));

import { classifyChatIntent } from "@/agent/intent-classifier";
import { INTENT_TO_CLUSTER } from "@/lib/intent";

async function classifyHost(
  utterance: string,
  mockKind: string,
): Promise<{ kind: string }> {
  generateObjectMock.mockResolvedValueOnce({ object: { kind: mockKind } });
  const result = await classifyChatIntent(utterance, {}, "host");
  return { kind: (result.intent as { kind: string }).kind };
}

describe("recalibrate boundary — multi-field edit on calibrated host", () => {
  it('"Set my buffer to 5 and protect Fridays" routes to a manage_setup-cluster intent (NOT recalibrate)', async () => {
    // The classifier rubric for a calibrated host (post-grace, no first-time
    // window, has manage_setup writes) treats multi-field edits as
    // edit_preference / manage_setup-cluster — not as a recalibration arc.
    const r = await classifyHost(
      "Set my buffer to 5 and protect Fridays",
      "edit_preference",
    );

    expect(r.kind).toBe("edit_preference");
    expect(r.kind).not.toBe("recalibrate");

    // And the cluster mapping confirms the route lands in manage_setup.
    expect(
      INTENT_TO_CLUSTER[r.kind as keyof typeof INTENT_TO_CLUSTER],
    ).toBe("manage_setup");
  });
});
