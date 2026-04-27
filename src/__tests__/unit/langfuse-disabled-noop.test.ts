/**
 * Langfuse wrapper — disabled-path no-op contract.
 *
 * The production guarantee: when `LANGFUSE_ENABLED !== "true"`, every
 * export of `src/lib/langfuse.ts` is a no-op that falls through to
 * the wrapped function with no side effects, no SDK import attempt,
 * and no thrown errors. This test exercises that contract.
 *
 * What this test does NOT cover:
 *   - The enabled path against a real Langfuse server. That's a
 *     dev-time convenience, not a production guarantee, and ships
 *     wired up but not asserted here.
 *   - The lazy SDK loader's success branch. The SDK is a
 *     `devDependencies` entry; production never reaches that branch.
 *
 * Per Phase 5 PR-1 brief deliverable 7.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = process.env.LANGFUSE_ENABLED;

describe("langfuse — disabled-path no-op contract", () => {
  beforeEach(() => {
    // Wipe the flag so every test starts with Langfuse OFF. We re-import
    // the module per test (vitest module isolation) so the cached client
    // state in langfuse.ts doesn't leak across cases.
    delete process.env.LANGFUSE_ENABLED;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.LANGFUSE_ENABLED;
    } else {
      process.env.LANGFUSE_ENABLED = ORIGINAL_ENV;
    }
  });

  it("langfuseEnabled() returns false when env var is unset", async () => {
    const { langfuseEnabled } = await import("@/lib/langfuse");
    expect(langfuseEnabled()).toBe(false);
  });

  it("langfuseEnabled() returns false for any non-'true' value", async () => {
    const { langfuseEnabled } = await import("@/lib/langfuse");
    process.env.LANGFUSE_ENABLED = "1";
    expect(langfuseEnabled()).toBe(false);
    process.env.LANGFUSE_ENABLED = "yes";
    expect(langfuseEnabled()).toBe(false);
    process.env.LANGFUSE_ENABLED = "false";
    expect(langfuseEnabled()).toBe(false);
    process.env.LANGFUSE_ENABLED = "TRUE"; // strict equality on lowercase
    expect(langfuseEnabled()).toBe(false);
  });

  it("getLangfuseClient() returns null when disabled", async () => {
    const { getLangfuseClient } = await import("@/lib/langfuse");
    expect(getLangfuseClient()).toBeNull();
  });

  it("startTrace() returns null when disabled", async () => {
    const { startTrace } = await import("@/lib/langfuse");
    expect(startTrace("composer.compose")).toBeNull();
    expect(startTrace("composer.compose", { foo: "bar" })).toBeNull();
  });

  it("recordSpan() invokes fn and returns its result without side effects", async () => {
    const { recordSpan } = await import("@/lib/langfuse");
    const sentinel = Symbol("sentinel");
    let calls = 0;
    const result = await recordSpan("composer.compose", async () => {
      calls += 1;
      return sentinel;
    });
    expect(calls).toBe(1);
    expect(result).toBe(sentinel);
  });

  it("recordSpan() preserves async errors thrown by fn", async () => {
    const { recordSpan } = await import("@/lib/langfuse");
    const err = new Error("boom");
    await expect(
      recordSpan("intent-classifier.classify", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it("recordSpan() does NOT throw if Langfuse SDK fails to load", async () => {
    // Even if the SDK package is missing or broken, the disabled path
    // never attempts to load it, so this is a degenerate check — but
    // it's the production guarantee the brief calls out explicitly:
    // "instrumentation must never break production".
    const { recordSpan } = await import("@/lib/langfuse");
    const result = await recordSpan("composer.compose", async () => 42);
    expect(result).toBe(42);
  });

  it("recordSpanSync() falls through to fn when disabled", async () => {
    const { recordSpanSync } = await import("@/lib/langfuse");
    let calls = 0;
    const result = recordSpanSync("composer.compose", () => {
      calls += 1;
      return "ok";
    });
    expect(calls).toBe(1);
    expect(result).toBe("ok");
  });

  it("recordSpanSync() preserves sync errors thrown by fn", async () => {
    const { recordSpanSync } = await import("@/lib/langfuse");
    const err = new Error("sync-boom");
    expect(() =>
      recordSpanSync("composer.compose", () => {
        throw err;
      }),
    ).toThrow(err);
  });
});
