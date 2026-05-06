/**
 * Unit tests for the calibrate-followthrough dispatch override predicate.
 *
 * Architecture as of 2026-05-06 choice-panel refactor:
 *   - calibrate-opener writes seed-info only.
 *   - calibrate-proceed writes the opener when host picks path (b).
 *   - Override must fire ONLY when calibrate-opener is present (not seed-info
 *     alone), so path (a) hosts are not incorrectly force-routed.
 *
 * Hotfix-3 regression (preserved): the N-message lookback was added because
 * the opener can be second-most-recent if a system message was interleaved.
 * That robustness is still in the predicate (lookback default 5).
 */
import { describe, it, expect } from "vitest";
import { shouldForceCalibrateFirstTime } from "@/lib/onboarding/calibrate-followthrough-override";

const NOW = Date.now();

function envoy(subkind: string | null, ageMs: number) {
  return {
    metadata: subkind ? { kind: "onboarding", subkind } : null,
    createdAt: new Date(NOW - ageMs),
  };
}

describe("shouldForceCalibrateFirstTime", () => {
  it("fires when opener is most recent (normal path-b flow)", () => {
    const recent = [
      envoy("calibrate-opener", 1_000),
      envoy("calibrate-seed-info", 2_000),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(true);
  });

  it("fires when opener is present but not most recent (system message interleaved)", () => {
    const recent = [
      envoy(null, 500),                    // e.g. system response
      envoy("calibrate-opener", 1_500),
      envoy("calibrate-seed-info", 2_500),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(true);
  });

  it("does NOT fire when only seed-info is present (path-a or pre-choice)", () => {
    const recent = [
      envoy("calibrate-seed-info", 1_000),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(false);
  });

  it("does NOT fire when seed-info is most recent and no opener exists (choice-panel refactor invariant)", () => {
    // Regression guard: Hotfix-3 matched seed-info; the new arch must not.
    const recent = [
      envoy("calibrate-seed-info", 1_000),
      envoy(null, 2_000),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(false);
  });

  it("does NOT fire when neither subkind is present", () => {
    const recent = [
      envoy("dormant-context", 1_000),
      envoy(null, 2_000),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(false);
  });

  it("does NOT fire after the 30-minute window", () => {
    const recent = [envoy("calibrate-opener", 31 * 60 * 1000)];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(false);
  });

  it("respects the lookback bound (default 5)", () => {
    const recent = [
      envoy(null, 100),
      envoy(null, 200),
      envoy(null, 300),
      envoy(null, 400),
      envoy(null, 500),
      // calibrate-opener exists but past the lookback cutoff
      envoy("calibrate-opener", 600),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW, 5)).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(shouldForceCalibrateFirstTime([], NOW)).toBe(false);
  });
});
