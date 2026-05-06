/**
 * Variant-selection fixtures for the recalibrate `first-time` arc.
 *
 * Per HOTFIX 2026-05-05 (calibrate static opener): `selectVariant` now
 * reads `RecalibrateContext.isFirstTime` as a fallback when no explicit
 * `matchResult.playbookVariant` was stamped at the matcher / dispatch seam.
 * The dispatch override in `app/api/channel/chat/route.ts` is the primary
 * path; this fallback is the safety net for any case where the override
 * didn't fire but the host still belongs in the first-time arc.
 */
import { describe, expect, it } from "vitest";
import { selectVariant } from "@/agent/modules/recalibrate/playbook-variants";
import { makeFirstTimeContext } from "./_helpers";
import type { MatchResult } from "@/agent/modules/types";

describe("recalibrate selectVariant — first-time arc", () => {
  it("falls back to first-time when contextOutput.isFirstTime is true and no explicit variant", () => {
    const matchResult: MatchResult = {
      kind: "deterministic",
      resolved: {},
    };
    const ctx = makeFirstTimeContext("I do MWF, 25-min meetings");
    // _helpers default: isFirstTime: true
    expect(selectVariant(matchResult, ctx)).toBe("first-time");
  });

  it("explicit playbookVariant wins over isFirstTime fallback", () => {
    const matchResult: MatchResult = {
      kind: "deterministic",
      resolved: {},
      playbookVariant: "explicit-ask",
    };
    const ctx = makeFirstTimeContext("retune my schedule");
    // isFirstTime in ctx is true, but the explicit hint wins.
    expect(selectVariant(matchResult, ctx)).toBe("explicit-ask");
  });

  it("falls through to open when no hint and not first-time", () => {
    const matchResult: MatchResult = {
      kind: "deterministic",
      resolved: {},
    };
    const ctx = makeFirstTimeContext("change my buffer to 10 minutes");
    ctx.isFirstTime = false;
    expect(selectVariant(matchResult, ctx)).toBe("open");
  });

  it("explicit first-time hint resolves to first-time", () => {
    const matchResult: MatchResult = {
      kind: "deterministic",
      resolved: {},
      playbookVariant: "first-time",
    };
    const ctx = makeFirstTimeContext("anything");
    ctx.isFirstTime = false; // exercise that the hint, not the flag, drives.
    expect(selectVariant(matchResult, ctx)).toBe("first-time");
  });

  it("unknown explicit variant falls through, then isFirstTime fallback applies", () => {
    const matchResult: MatchResult = {
      kind: "deterministic",
      resolved: {},
      playbookVariant: "bogus-variant",
    };
    const ctx = makeFirstTimeContext("I want MWF");
    expect(selectVariant(matchResult, ctx)).toBe("first-time");
  });
});
