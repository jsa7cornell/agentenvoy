/**
 * Parity test for `deriveTimingAnchor`.
 *
 * This helper is the single source of truth for turning a free-form
 * `timingLabel` into a structured anchor used by BOTH:
 *   - The web greeting's prose opener (`src/app/api/negotiate/session/route.ts`,
 *     `proseAnchor`).
 *   - The MCP `get_meeting_parameters` response's `rules.timingPreference.anchor`.
 *
 * If the regex diverges from the historical prose-greeting pattern, guest-side
 * MCP agents produce different framing than the web product. This test is the
 * Rule-16 equivalent guarding that sync.
 */
import { describe, it, expect } from "vitest";
import { deriveTimingAnchor } from "@/lib/scoring";

describe("deriveTimingAnchor — this-week bucket", () => {
  it.each([
    ["this week", "this-week"],
    ["This Week", "this-week"],
    ["today", "this-week"],
    ["tomorrow", "this-week"],
    ["ASAP", "this-week"],
    ["soon if possible", "this-week"],
    ["this week for a quick chat", "this-week"],
  ] as const)("%s → %s", (input, expected) => {
    expect(deriveTimingAnchor(input)).toBe(expected);
  });
});

describe("deriveTimingAnchor — next-week bucket", () => {
  it.each([
    ["next week", "next-week"],
    ["Next Week", "next-week"],
    ["next Monday", "next-week"],
    ["next Tuesday morning", "next-week"],
    ["next Fri", "next-week"],
    ["some time next week if that works", "next-week"],
  ] as const)("%s → %s", (input, expected) => {
    expect(deriveTimingAnchor(input)).toBe(expected);
  });
});

describe("deriveTimingAnchor — null bucket", () => {
  it.each([null, undefined, "", "   ", "flexible", "any time", "late October"])(
    "%s → null",
    (input) => {
      expect(deriveTimingAnchor(input)).toBe(null);
    },
  );
});

/**
 * Parity guard: replicate the historical regex from `session/route.ts`
 * (pre-refactor, commit `ac306de`) and confirm the extracted helper matches
 * it exactly on a representative input set. If this test fails, either the
 * helper or the historical regex changed — reconcile deliberately.
 */
describe("deriveTimingAnchor — parity with pre-refactor web greeting regex", () => {
  function legacyProseAnchor(label: string | null): "this-week" | "next-week" | null {
    if (!label) return null;
    const lc = label.toLowerCase();
    if (/\bthis\s+week\b|\btoday\b|\btomorrow\b|\basap\b|\bsoon\b/.test(lc)) {
      return "this-week";
    }
    if (/\bnext\s+week\b|\bnext\s+(mon|tue|wed|thu|fri|sat|sun)/.test(lc)) {
      return "next-week";
    }
    return null;
  }

  const inputs = [
    "this week",
    "next week",
    "today",
    "tomorrow",
    "ASAP",
    "soon",
    "next Friday",
    "next Tue",
    "late October",
    "flexible",
    "",
    null,
  ];

  it.each(inputs)("parity for %s", (input) => {
    expect(deriveTimingAnchor(input)).toBe(legacyProseAnchor(input));
  });
});
