import { describe, it, expect } from "vitest";
import { nextPhase, type OnboardingPhase } from "@/lib/onboarding-machine";

describe("nextPhase — active trimmed flow", () => {
  it("intro → defaults_confirm", () => {
    expect(nextPhase("intro")).toBe("defaults_confirm");
  });

  it("defaults_confirm → complete", () => {
    expect(nextPhase("defaults_confirm")).toBe("complete");
  });

  it("complete stays at complete (tail clamp)", () => {
    expect(nextPhase("complete")).toBe("complete");
  });
});

describe("nextPhase — legacy phase promotion", () => {
  // Mid-flow users whose stored phase was trimmed in the 2026-04-21 proposal
  // auto-promote to defaults_confirm rather than getting stuck. This keeps
  // the unique index in-sync with a linear PHASE_ORDER even after trims.
  // Phases in the OnboardingPhase union that are NOT in the active
  // PHASE_ORDER ("intro" → "defaults_confirm" → "complete"). A user whose
  // stored phase lands in one of these should auto-promote forward.
  const legacyPhases: OnboardingPhase[] = [
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
    it(`${phase} → defaults_confirm`, () => {
      expect(nextPhase(phase)).toBe("defaults_confirm");
    });
  }
});
