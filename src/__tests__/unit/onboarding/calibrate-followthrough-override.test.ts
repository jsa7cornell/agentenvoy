/**
 * Unit tests for the calibrate-followthrough dispatch override predicate.
 *
 * Hotfix-3 regression test: the bug fixed here was that Hotfix-2 added a
 * seed-info Envoy message which became the most-recent envoy turn, and
 * Hotfix-1's predicate (which only matched `subkind: "calibrate-opener"`)
 * stopped firing. The override skipped, the user's reply routed to
 * manage_setup, and a phantom bookable link got created.
 *
 * These tests lock both behaviors:
 *   1. Override fires when EITHER calibrate-* subkind is present.
 *   2. Override fires across the most-recent N envoy messages (seed-info-most-recent
 *      + opener-second-most-recent is the canonical scenario).
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
  it("fires when seed-info is most recent (Hotfix-3 regression scenario)", () => {
    const recent = [
      envoy("calibrate-seed-info", 1_000),
      envoy("calibrate-opener", 2_000),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(true);
  });

  it("fires when opener is most recent", () => {
    const recent = [
      envoy("calibrate-opener", 1_000),
      envoy("calibrate-seed-info", 2_000),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(true);
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

  it("fires when calibrate-* is interleaved among non-calibrate envoy turns inside lookback", () => {
    const recent = [
      envoy(null, 500),                       // composer response with no subkind
      envoy("calibrate-seed-info", 1_500),
      envoy("calibrate-opener", 2_500),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW)).toBe(true);
  });

  it("respects the lookback bound (default 5)", () => {
    const recent = [
      envoy(null, 100),
      envoy(null, 200),
      envoy(null, 300),
      envoy(null, 400),
      envoy(null, 500),
      // calibrate-* exists but past the lookback cutoff
      envoy("calibrate-opener", 600),
    ];
    expect(shouldForceCalibrateFirstTime(recent, NOW, 5)).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(shouldForceCalibrateFirstTime([], NOW)).toBe(false);
  });
});
