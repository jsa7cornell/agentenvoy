import { describe, it, expect } from "vitest";
import { nextPhase, type OnboardingPhase } from "@/lib/onboarding-machine";

describe("nextPhase — active trimmed flow", () => {
  it("intro → complete", () => {
    // Post-2026-04-23 sunset of `defaults_confirm`: intro now advances
    // directly to `complete`, which inlines the seed-preview bubble.
    expect(nextPhase("intro")).toBe("complete");
  });

  it("complete stays at complete (tail clamp)", () => {
    expect(nextPhase("complete")).toBe("complete");
  });
});

describe("nextPhase — legacy phase promotion", () => {
  // Mid-flow users whose stored phase was trimmed auto-promote to
  // `complete` rather than getting stuck. This keeps the PHASE_ORDER
  // linear even after trims. All legacy values — including the 2026-04-23
  // sunset `defaults_confirm` — map forward to `complete`.
  const legacyPhases: OnboardingPhase[] = [
    "defaults_confirm",
    "defaults_format",
    "phone_number",
    "zoom_link",
    "defaults_duration",
    "defaults_buffer",
    "calendar_rules",
    "calendar_rules_custom",
    "calendar_evenings",
  ];

  for (const phase of legacyPhases) {
    it(`${phase} → complete`, () => {
      expect(nextPhase(phase)).toBe("complete");
    });
  }
});
