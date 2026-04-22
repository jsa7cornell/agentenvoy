/**
 * Unit tests for the deterministic echo-of-recent-envoy detector.
 *
 * Proposal: 2026-04-22_chat-intent-router-context-carryover-and-echo-false-positive §4.4.
 */

import { describe, it, expect } from "vitest";
import { isEchoOfRecentEnvoy } from "@/lib/echo-detect";

const LONG_ENVOY_A =
  "Looks like you're quoting back my last reply — did you mean to send a new request? If you want to tweak the Jon bike ride link or set something else up, just let me know.";

describe("isEchoOfRecentEnvoy", () => {
  it("flags a verbatim copy as echo with overlap ~1.0", () => {
    const r = isEchoOfRecentEnvoy(LONG_ENVOY_A, [LONG_ENVOY_A]);
    expect(r.isEcho).toBe(true);
    expect(r.matchedIndex).toBe(0);
    expect(r.overlap).toBeGreaterThanOrEqual(0.99);
  });

  it("flags a ~92% paraphrase (small tail change) as echo", () => {
    const paraphrase =
      "Looks like you're quoting back my last reply — did you mean to send a new request? If you want to tweak the Jon bike ride link or set something else up, go ahead.";
    const r = isEchoOfRecentEnvoy(paraphrase, [LONG_ENVOY_A]);
    expect(r.isEcho).toBe(true);
    expect(r.overlap).toBeGreaterThanOrEqual(0.85);
  });

  it("does NOT flag ~70% overlap as echo", () => {
    // Share roughly the first ~70% as a contiguous substring, then diverge.
    const envoy =
      "Here is a message that has a stable opening that is used as a common substring for testing overlap detection between user and envoy.";
    const user =
      "Here is a message that has a stable opening that is used as a common substring for testing — then totally different text appears after that, okay great fine whatever.";
    const r = isEchoOfRecentEnvoy(user, [envoy]);
    expect(r.isEcho).toBe(false);
    expect(r.overlap).toBeLessThan(0.85);
  });

  it("does NOT flag entirely different content", () => {
    const r = isEchoOfRecentEnvoy(
      "Set up a 3-hour bike ride with Jon next week please.",
      [LONG_ENVOY_A],
    );
    expect(r.isEcho).toBe(false);
    expect(r.overlap).toBeLessThan(0.3);
    expect(r.matchedIndex).toBeNull();
  });

  it("skips envoy messages shorter than the noise floor", () => {
    const r = isEchoOfRecentEnvoy("new", ["new", "new one", "yes"]);
    expect(r.isEcho).toBe(false);
    expect(r.matchedIndex).toBeNull();
  });

  it("skips empty envoy messages without crashing", () => {
    const r = isEchoOfRecentEnvoy("anything", ["", "   "]);
    expect(r.isEcho).toBe(false);
  });

  it("treats markdown-vs-plain variants the same after normalization", () => {
    const plain = LONG_ENVOY_A;
    const markdown =
      "**Looks like** you're *quoting back* my last reply — did you mean to send a `new request`? If you want to tweak the Jon bike ride link or set something else up, just let me know.";
    const r = isEchoOfRecentEnvoy(markdown, [plain]);
    expect(r.isEcho).toBe(true);
    expect(r.overlap).toBeGreaterThanOrEqual(0.95);
  });

  it("returns the index of the best-matching recent envoy message", () => {
    const unrelated = "Totally unrelated envoy reply about something else entirely, nothing to do with bike rides or Jon.";
    const r = isEchoOfRecentEnvoy(LONG_ENVOY_A, [unrelated, LONG_ENVOY_A, unrelated]);
    expect(r.isEcho).toBe(true);
    expect(r.matchedIndex).toBe(1);
  });

  it("respects a custom threshold", () => {
    // Same ~70% case above, but lower the threshold to 0.5 — should flag.
    const envoy =
      "Here is a message that has a stable opening that is used as a common substring for testing overlap detection between user and envoy.";
    const user =
      "Here is a message that has a stable opening that is used as a common substring for testing — then different stuff.";
    const strict = isEchoOfRecentEnvoy(user, [envoy], 0.95);
    expect(strict.isEcho).toBe(false);
    const loose = isEchoOfRecentEnvoy(user, [envoy], 0.5);
    expect(loose.isEcho).toBe(true);
  });
});
