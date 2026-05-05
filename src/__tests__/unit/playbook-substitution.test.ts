import { describe, it, expect } from "vitest";
import { calendarEventComposer } from "@/agent/runtime-prompts";

describe("playbook substitution — calendar-event-composer", () => {
  const playbook = calendarEventComposer();

  it("contains no unreplaced substitution placeholders", () => {
    // If a placeholder leaks through to the LLM it shows up as literal
    // {{ACTIVITY_VOCAB_TABLE}} in the prompt — the LLM ignores it but the
    // canonical vocab also never reaches the model. Fail loud.
    expect(playbook).not.toContain("{{ACTIVITY_VOCAB_TABLE}}");
    expect(playbook).not.toContain("{{ACTIVITY_NATURAL_WINDOWS}}");
  });

  it("contains canonical activity vocabulary entries (substituted in)", () => {
    expect(playbook).toContain("☕ coffee");
    expect(playbook).toContain("🚴 bike ride");
    expect(playbook).toContain("🍻 drinks");
  });

  it("source-of-truth pointer to activity-vocab.ts is in the rendered output", () => {
    expect(playbook).toContain("activity-vocab.ts");
  });

  it("natural-windows table is rendered (proposal §3.D — proactive widening)", () => {
    // Activities WITH a natural window appear with their HH:MM range.
    expect(playbook).toContain("☕ coffee");
    expect(playbook).toContain("07:00–10:00");
    expect(playbook).toContain("17:00–21:00"); // drinks
    // Markdown table header is present.
    expect(playbook).toMatch(/\| Activity \| Natural window/);
  });

  it("PR3 playbook additions are present", () => {
    // Time-of-day vocabulary table (proposal §3.A.1)
    expect(playbook).toContain("Time-of-day vocabulary");
    expect(playbook).toMatch(/"open up evenings"\s*\/\s*"also after 5pm"/);
    // blockedRanges section (proposal §3.5)
    expect(playbook).toContain("blockedRanges");
    expect(playbook).toContain("One-off date-and-time exclusions");
    // Event-scoped phrasing rule (proposal §3.A)
    expect(playbook).toContain("Event-scoped phrasing rule");
    // Proactive widening (proposal §3.D)
    expect(playbook).toContain("Proactive widening on activity set or change");
  });
});
