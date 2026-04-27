/**
 * Unit tests for the candidate-set PII scrub utility (Phase 4 PR 2).
 *
 * Tests live under `src/__tests__/unit/` — not next to the script —
 * because that's the only path the unit-vitest config (`vitest.unit.config.ts`)
 * globs. The script itself stays in `scripts/eval-candidates/`; test
 * imports cross via relative path, mirroring the bench-intent precedent
 * (`bench-intent-runner.test.ts`).
 */

import { describe, expect, test } from "vitest";
import { scrubPII } from "../../../scripts/eval-candidates/pii-scrub";

describe("scrubPII", () => {
  test("empty input returns empty result", () => {
    const r = scrubPII("", { knownNames: [] });
    expect(r).toEqual({ text: "", replacements: 0 });
  });

  test("single email replaced with <EMAIL_1>", () => {
    const r = scrubPII("contact me at sarah@example.com", { knownNames: [] });
    expect(r.text).toBe("contact me at <EMAIL_1>");
    expect(r.replacements).toBe(1);
  });

  test("multiple distinct emails get distinct placeholders", () => {
    const r = scrubPII("a@x.com or b@y.com", { knownNames: [] });
    expect(r.text).toBe("<EMAIL_1> or <EMAIL_2>");
    expect(r.replacements).toBe(2);
  });

  test("same email twice collapses to same placeholder", () => {
    const r = scrubPII("write to a@x.com or a@x.com", { knownNames: [] });
    expect(r.text).toBe("write to <EMAIL_1> or <EMAIL_1>");
    expect(r.replacements).toBe(2);
  });

  test("phone format +1 555-555-5555 scrubs to <PHONE>", () => {
    const r = scrubPII("call +1 555-555-5555 anytime", { knownNames: [] });
    expect(r.text).toBe("call <PHONE> anytime");
    expect(r.replacements).toBe(1);
  });

  test("phone format (555) 555-5555 scrubs to <PHONE>", () => {
    const r = scrubPII("call (555) 555-5555 anytime", { knownNames: [] });
    expect(r.text).toBe("call <PHONE> anytime");
    expect(r.replacements).toBe(1);
  });

  test("phone format 555-555-5555 scrubs to <PHONE>", () => {
    const r = scrubPII("call 555-555-5555 anytime", { knownNames: [] });
    expect(r.text).toBe("call <PHONE> anytime");
    expect(r.replacements).toBe(1);
  });

  test("phone format 555.555.5555 scrubs to <PHONE>", () => {
    const r = scrubPII("call 555.555.5555 anytime", { knownNames: [] });
    expect(r.text).toBe("call <PHONE> anytime");
    expect(r.replacements).toBe(1);
  });

  test("known-name single occurrence replaced with <NAME_1>", () => {
    const r = scrubPII("meeting with Sarah Chen tomorrow", {
      knownNames: ["Sarah Chen"],
    });
    expect(r.text).toBe("meeting with <NAME_1> tomorrow");
    expect(r.replacements).toBe(1);
  });

  test("known-name re-occurrence reuses same placeholder within one call", () => {
    const r = scrubPII("Sarah said yes — confirm with Sarah?", {
      knownNames: ["Sarah"],
    });
    expect(r.text).toBe("<NAME_1> said yes — confirm with <NAME_1>?");
    expect(r.replacements).toBe(2);
  });

  test("known-name word-boundary: substring does NOT match", () => {
    const r = scrubPII("Sarahchen is not a real name", {
      knownNames: ["Sarah"],
    });
    expect(r.text).toBe("Sarahchen is not a real name");
    expect(r.replacements).toBe(0);
  });

  test("known-name case-insensitive", () => {
    const r = scrubPII("sarah CHEN said hi", {
      knownNames: ["Sarah Chen"],
    });
    expect(r.text).toBe("<NAME_1> said hi");
    expect(r.replacements).toBe(1);
  });

  test("mixed: name + email + phone in one string", () => {
    const r = scrubPII(
      "email Sarah at sarah@chen.com or call (415) 555-1234",
      { knownNames: ["Sarah"] },
    );
    expect(r.text).toBe(
      "email <NAME_1> at <EMAIL_1> or call <PHONE>",
    );
    expect(r.replacements).toBe(3);
  });

  test("URL passthrough — left intact", () => {
    const r = scrubPII("see https://agentenvoy.ai/meet/abc", {
      knownNames: [],
    });
    expect(r.text).toBe("see https://agentenvoy.ai/meet/abc");
    expect(r.replacements).toBe(0);
  });

  test("short numerics (e.g. '30 min') are not eaten by phone regex", () => {
    const r = scrubPII("how about 30 min on Tuesday at 2pm", {
      knownNames: [],
    });
    expect(r.text).toBe("how about 30 min on Tuesday at 2pm");
    expect(r.replacements).toBe(0);
  });

  test("placeholder literal in input does not double-scrub", () => {
    // Defensive: make sure feeding back a previously-scrubbed string
    // doesn't recurse or accidentally re-match inside the angle-bracket
    // tokens. The regexes don't match `<NAME_1>` as either an email or
    // phone, so the result should be identical to the input.
    const r = scrubPII("hello <NAME_1>, your slot is at 2pm", {
      knownNames: [],
    });
    expect(r.text).toBe("hello <NAME_1>, your slot is at 2pm");
    expect(r.replacements).toBe(0);
  });
});
