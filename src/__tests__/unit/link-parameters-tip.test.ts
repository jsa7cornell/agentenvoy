/**
 * Tests for the `tip` field extension to linkParametersSchema (PR4).
 */

import { describe, it, expect } from "vitest";
import { parseLinkParameters } from "@/lib/link-parameters";

describe("parseLinkParameters — tip field", () => {
  it("accepts a string tip field", () => {
    const result = parseLinkParameters({ tip: "See you soon!" });
    expect(result.tip).toBe("See you soon!");
  });

  it("accepts a tip field at exactly 280 chars", () => {
    const longTip = "a".repeat(280);
    const result = parseLinkParameters({ tip: longTip });
    expect(result.tip).toBe(longTip);
  });

  it("rejects a tip field over 280 chars", () => {
    const tooLong = "a".repeat(281);
    // parseLinkParameters is fail-soft — returns {} on schema failure
    const result = parseLinkParameters({ tip: tooLong });
    // The whole parse fails and returns {} when any field is invalid
    expect(result.tip).toBeUndefined();
  });

  it("accepts undefined tip (optional field)", () => {
    const result = parseLinkParameters({ duration: 30 });
    expect(result.tip).toBeUndefined();
  });

  it("preserves other fields alongside tip", () => {
    const result = parseLinkParameters({
      duration: 45,
      format: "video",
      tip: "Looking forward to it!",
    });
    expect(result.duration).toBe(45);
    expect(result.format).toBe("video");
    expect(result.tip).toBe("Looking forward to it!");
  });
});
