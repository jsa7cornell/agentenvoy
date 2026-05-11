/**
 * Unit tests for `validateTip` — Phase 2 PR4 (2026-05-11).
 *
 * Pure unit tests: no I/O, no mocks needed. Covers:
 *   - Clean accept (no forbidden patterns, within length)
 *   - Each forbidden pattern (date / time / format word / literal location /
 *     over-200 chars / empty) — one test per case
 *
 * Per proposal 2026-05-11_llm-tip-seed-at-create-link.md §8.1 v2 tests.
 */

import { describe, it, expect } from "vitest";
import { validateTip } from "@/lib/meeting-tip/validate-tip";

describe("validateTip", () => {
  it("accepts a clean tip with no forbidden patterns", () => {
    const result = validateTip("Looking forward to catching up!", null);
    expect(result.valid).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("accepts tip with optional location parameter that is null", () => {
    const result = validateTip("Excited to ride and talk through the proposal.", null);
    expect(result.valid).toBe(true);
  });

  it("rejects a tip containing a date word (day of week)", () => {
    const result = validateTip("Looking forward to our chat on Monday!", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:date");
  });

  it("rejects a tip containing a date word (month abbreviation)", () => {
    const result = validateTip("Can't wait for our Jan meeting!", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:date");
  });

  it("rejects a tip containing a time string (e.g. 3pm)", () => {
    const result = validateTip("Looking forward to our Zoom at 3pm!", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:time");
  });

  it("rejects a tip containing a time string with colon (e.g. 10:30 AM)", () => {
    const result = validateTip("See you at 10:30 AM!", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:time");
  });

  it("rejects a tip containing the format word 'zoom'", () => {
    const result = validateTip("I'll send the Zoom invite soon.", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:format");
  });

  it("rejects a tip containing the format word 'google meet'", () => {
    const result = validateTip("Let's connect over Google Meet.", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:format");
  });

  it("rejects a tip containing the format word 'phone'", () => {
    const result = validateTip("Let's do a quick phone call.", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:format");
  });

  it("rejects a tip containing the format word 'video'", () => {
    const result = validateTip("Looking forward to our video chat!", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:format");
  });

  it("rejects a tip containing the format word 'in-person'", () => {
    const result = validateTip("Happy to meet in-person!", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:format");
  });

  it("rejects a tip containing the literal location string", () => {
    // Location is "Coupa Cafe" — tip says "Coupa Cafe" → exact substring match
    const result = validateTip("See you at Coupa Cafe — great spot!", "Coupa Cafe");
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:literal_location");
  });

  it("location check is case-insensitive", () => {
    const result = validateTip("Meet you at coupa cafe!", "Coupa Cafe");
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:literal_location");
  });

  it("does NOT flag location if location param is null", () => {
    const result = validateTip("Pick a coffee spot that works for you.", null);
    expect(result.valid).toBe(true);
  });

  it("does NOT flag location if location param is empty string", () => {
    const result = validateTip("Pick a spot that works!", "");
    expect(result.valid).toBe(true);
  });

  it("rejects a tip that exceeds 200 characters", () => {
    const longTip = "A".repeat(201);
    const result = validateTip(longTip, null);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("too_long:"))).toBe(true);
  });

  it("accepts a tip of exactly 200 characters", () => {
    const exactTip = "A".repeat(200);
    const result = validateTip(exactTip, null);
    expect(result.valid).toBe(true);
  });

  it("rejects an empty string", () => {
    const result = validateTip("", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("empty");
  });

  it("rejects a whitespace-only string", () => {
    const result = validateTip("   ", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("empty");
  });

  it("rejects undefined", () => {
    const result = validateTip(undefined, null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("empty");
  });

  it("accumulates multiple failure reasons in one result", () => {
    // Tuesday (date) + 3pm (time) + zoom (format)
    const result = validateTip("See you Tuesday at 3pm on Zoom!", null);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("forbidden_pattern:date");
    expect(result.reasons).toContain("forbidden_pattern:time");
    expect(result.reasons).toContain("forbidden_pattern:format");
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
