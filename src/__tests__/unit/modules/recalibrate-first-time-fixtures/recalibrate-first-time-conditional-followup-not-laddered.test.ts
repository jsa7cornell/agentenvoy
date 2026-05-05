/**
 * Fixture 7 — F8 single-question discipline (N4).
 *
 * After the composer's initial extraction turn, conditional follow-ups for
 * missing fields (zoom_link when format=Zoom, phone when format=Phone,
 * guest_flex if not volunteered) MUST bundle into ONE consolidated question
 * rather than ladder into one turn per missing field.
 *
 * The discipline is encoded in the `composers/recalibrate/first-time.md`
 * fragment. The check predicate can't enforce prose shape directly; this
 * fixture pins the fragment-level invariant so silently dropping the
 * directive surfaces as a test failure.
 *
 * Per proposal §3.6 + Author Response N4 (F8 question-laddering avoidance).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const FRAGMENT_PATH = join(
  process.cwd(),
  "src/agent/runtime-prompts/composers/recalibrate/first-time.md",
);

describe("recalibrate first-time — conditional follow-ups not laddered (F8)", () => {
  const fragment = readFileSync(FRAGMENT_PATH, "utf-8");

  it("documents the bundle-into-one-turn directive", () => {
    // Encodes the §2.7a + N4 discipline: missing-field follow-ups consolidate.
    expect(fragment.toLowerCase()).toMatch(
      /(single|one)\s+(?:consolidated\s+)?(?:question|turn)/,
    );
    expect(fragment.toLowerCase()).toContain("bundle");
  });

  it("explicitly names the F8 anti-pattern so authoring drift surfaces", () => {
    expect(fragment).toMatch(/F8|ladder/i);
  });
});
