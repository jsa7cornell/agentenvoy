/**
 * Unit tests for the Phase 1 greeting → tip shim.
 *
 * Covers: prefix-stripping, paragraph collapse, length truncation,
 * idempotency on edge cases (empty, no-prefix, anonymous, long input).
 *
 * See proposal 2026-05-08 §4.1.
 *
 * REMINDER: this test file is deleted along with from-greeting-shim.ts
 * in Phase 2. `git grep from-greeting-shim` must return no matches
 * after the Phase 2 shim deletion. See proposal N5.
 */

import { describe, it, expect } from "vitest";
import { tipFromGreeting } from "@/lib/meeting-tip/from-greeting-shim";

describe("tipFromGreeting — Phase 1 shim", () => {
  it("strips 👋 [name]! prefix (exclamation)", () => {
    const greeting = "👋 Sarah! I'm AgentEnvoy, scheduling on behalf of John. Looking forward to connecting!";
    const result = tipFromGreeting(greeting);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("I'm AgentEnvoy, scheduling on behalf of John. Looking forward to connecting!");
    expect(result!.source).toBeUndefined();
  });

  it("strips 👋 [name], prefix (comma variant)", () => {
    const greeting = "👋 Sarah, John is looking forward to a quick call. Here's what to expect.";
    const result = tipFromGreeting(greeting);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("John is looking forward to a quick call. Here's what to expect.");
  });

  it("strips 👋 Hi [name]! prefix (Hi variant)", () => {
    const greeting = "👋 Hi Sarah! Happy to help you find a time with John.";
    const result = tipFromGreeting(greeting);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Happy to help you find a time with John.");
  });

  it("strips wave emoji from anonymous greeting (no name)", () => {
    const greeting = "👋 Thanks for visiting John's scheduling page. Pick a time that works.";
    const result = tipFromGreeting(greeting);
    expect(result).not.toBeNull();
    // Anonymous: no name after the wave; wave + trailing space stripped.
    expect(result!.text).toContain("Thanks for visiting");
    expect(result!.text).not.toContain("👋");
  });

  it("leaves greeting without wave emoji unchanged", () => {
    const greeting = "Hi Sarah! Looking forward to our call.";
    const result = tipFromGreeting(greeting);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hi Sarah! Looking forward to our call.");
  });

  it("truncates long greeting to 280 chars with ellipsis", () => {
    const long = "👋 Sarah! " + "This is a very long message. ".repeat(20);
    const result = tipFromGreeting(long);
    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(281); // 280 + "…"
    expect(result!.text.endsWith("…")).toBe(true);
  });

  it("returns null for empty string", () => {
    expect(tipFromGreeting("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(tipFromGreeting("   \n\n  ")).toBeNull();
  });

  it("collapses paragraph breaks to single newlines", () => {
    const greeting = "👋 Sarah! First paragraph.\n\nSecond paragraph.\n\n\nThird.";
    const result = tipFromGreeting(greeting);
    expect(result).not.toBeNull();
    expect(result!.text).not.toMatch(/\n{2,}/);
    expect(result!.text).toContain("First paragraph.");
    expect(result!.text).toContain("Second paragraph.");
  });

  it("is idempotent — stripping an already-stripped string returns the same result", () => {
    const greeting = "👋 Sarah! John runs short on Tuesdays. 30 min is the target.";
    const first = tipFromGreeting(greeting);
    const second = tipFromGreeting(first!.text);
    expect(second!.text).toBe(first!.text);
  });
});
