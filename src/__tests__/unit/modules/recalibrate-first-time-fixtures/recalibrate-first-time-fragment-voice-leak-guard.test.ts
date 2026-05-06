/**
 * Regression guard: the recalibrate first-time fragment must NOT contain
 * the example-mapping block that triggered hotfix-2 (2026-05-05). That block
 * was being pattern-matched by the composer as a RESPONSE template, leading
 * to bullet-format meta-narration like *"`my slots are 25m` →
 * defaultDuration: 25"* in production replies.
 *
 * Voice-leak markers are hard string-matched against the fragment. If you
 * find yourself wanting to add an extraction-mapping example back to the
 * fragment, don't — operational guidance survives in the surrounding prose;
 * the example is the leak.
 *
 * This is a fragment-source check, not a live-LLM check. It runs cheaply on
 * every test run and catches the regression class before it ships.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FRAGMENT_PATH = join(
  process.cwd(),
  "src/agent/runtime-prompts/composers/recalibrate/first-time.md",
);

describe("recalibrate first-time fragment — voice-leak guard", () => {
  const fragment = readFileSync(FRAGMENT_PATH, "utf8");

  it("does not contain the user-input → emissions example mapping block", () => {
    // The bad block was an "Expected emissions in ONE turn:" header followed
    // by bullets like "- `update_meeting_settings` with `defaultDuration: 25`".
    // Hotfix-2 removed it. Don't add it back.
    expect(fragment).not.toContain("Expected emissions in ONE turn");
    expect(fragment).not.toMatch(/User:\s*\*"I do MWF, 25-minute meetings/);
  });

  it("requires Voice section that names the host as 'you'", () => {
    expect(fragment).toContain("## Voice");
    // The Voice section must explicitly forbid third-person host references.
    expect(fragment).toMatch(/never "the user,"/);
    expect(fragment).toMatch(/never "the host,"/);
  });

  it("requires charitable-interpretation guidance", () => {
    expect(fragment).toMatch(/[Cc]haritable interpretation/);
    expect(fragment).toMatch(/Wednesdays open/);
  });

  it("does not contain a freestanding 'Expected emissions' bullet template the composer can mimic", () => {
    // Multi-line regex: header + blank line + bullet starting with `update_`.
    // This is the exact shape that pattern-matched as a response template in
    // the production leak. The Voice section's NEVER list quotes leak markers
    // inside backticks and prose, which is fine — what we forbid is the
    // bullet-list TEMPLATE shape.
    expect(fragment).not.toMatch(
      /Expected emissions[^\n]*\n\n-\s+`update_/,
    );
  });
});

/**
 * Composer-output-prose regression check.
 *
 * If a future fixture captures actual composer prose (e.g. via a live-LLM
 * snapshot or a deterministic-prose-extractor on streamed output), assert it
 * does not contain these voice-leak markers. The check below is exposed as
 * a helper so any such fixture can call it cheaply.
 */
export const VOICE_LEAK_MARKERS = [
  "the user",
  "Good catch",
  "→ defaultDuration",
  "→ defaultBuffer",
  "→ defaultFormat",
  "These are direct",
  "The emissions are correct",
];

export function assertNoVoiceLeak(prose: string): void {
  for (const marker of VOICE_LEAK_MARKERS) {
    if (prose.toLowerCase().includes(marker.toLowerCase())) {
      throw new Error(
        `Composer prose contains voice-leak marker "${marker}":\n${prose}`,
      );
    }
  }
}
