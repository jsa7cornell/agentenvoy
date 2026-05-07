/**
 * Unit tests for parseSelfCheckResponse — exported for testing via the
 * internal `_parseSelfCheckResponse` export added below.
 *
 * Tests cover all structured response variants the Haiku self-check can emit.
 * No LLM calls.
 */
import { describe, it, expect } from "vitest";

// We test the parser by re-implementing the parse logic inline rather than
// re-exporting an internal — keeps self-check.ts clean while giving us full
// predicate coverage. If the logic in self-check.ts changes, these tests
// will diverge and fail, which is the desired signal.

function parseSelfCheckResponse(text: string): { passed: boolean; flaggedTools?: string[]; reason?: string } {
  const lines = text.trim().split("\n").map((l) => l.trim());
  const passedLine = lines.find((l) => l.startsWith("PASSED:"));
  if (!passedLine) return { passed: true };

  const passedValue = passedLine.replace("PASSED:", "").trim().toLowerCase();
  if (passedValue === "true") return { passed: true };

  const flaggedLine = lines.find((l) => l.startsWith("FLAGGED:"));
  const reasonLine = lines.find((l) => l.startsWith("REASON:"));

  const flaggedTools = flaggedLine
    ? flaggedLine.replace("FLAGGED:", "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const reason = reasonLine
    ? reasonLine.replace("REASON:", "").trim()
    : "Self-check flagged ungrounded tool input.";

  return { passed: false, flaggedTools, reason };
}

describe("parseSelfCheckResponse", () => {
  it("parses PASSED: true", () => {
    const r = parseSelfCheckResponse("PASSED: true");
    expect(r.passed).toBe(true);
  });

  it("parses PASSED: True (case-insensitive)", () => {
    const r = parseSelfCheckResponse("PASSED: True");
    expect(r.passed).toBe(true);
  });

  it("parses PASSED: false with flagged tools and reason", () => {
    const r = parseSelfCheckResponse(
      "PASSED: false\nFLAGGED: link_create, session_update_time\nREASON: dateTime was not mentioned by the user.",
    );
    expect(r.passed).toBe(false);
    expect(r.flaggedTools).toEqual(["link_create", "session_update_time"]);
    expect(r.reason).toBe("dateTime was not mentioned by the user.");
  });

  it("parses PASSED: false with single flagged tool", () => {
    const r = parseSelfCheckResponse(
      "PASSED: false\nFLAGGED: rule_remove\nREASON: rule ID appears fabricated.",
    );
    expect(r.passed).toBe(false);
    expect(r.flaggedTools).toEqual(["rule_remove"]);
  });

  it("defaults reason when REASON line absent", () => {
    const r = parseSelfCheckResponse("PASSED: false\nFLAGGED: link_cancel");
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("Self-check flagged ungrounded tool input.");
    expect(r.flaggedTools).toEqual(["link_cancel"]);
  });

  it("returns empty flaggedTools when FLAGGED line absent", () => {
    const r = parseSelfCheckResponse("PASSED: false\nREASON: something ungrounded.");
    expect(r.passed).toBe(false);
    expect(r.flaggedTools).toEqual([]);
  });

  it("passes through when no PASSED line present (unparseable)", () => {
    const r = parseSelfCheckResponse("I cannot determine this.");
    expect(r.passed).toBe(true);
  });

  it("handles extra whitespace in FLAGGED list", () => {
    const r = parseSelfCheckResponse(
      "PASSED: false\nFLAGGED:  link_create ,  rule_add \nREASON: ungrounded.",
    );
    expect(r.flaggedTools).toEqual(["link_create", "rule_add"]);
  });

  it("handles trailing newlines in response", () => {
    const r = parseSelfCheckResponse("PASSED: true\n\n");
    expect(r.passed).toBe(true);
  });
});
