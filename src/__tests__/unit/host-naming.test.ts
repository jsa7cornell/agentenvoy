import { describe, it, expect } from "vitest";
import { hostFirstName } from "@/lib/host-naming";

describe("hostFirstName", () => {
  it("prefers firstName when set", () => {
    expect(hostFirstName({ firstName: "John", name: "Jane Doe" })).toBe("John");
  });

  it("trims firstName whitespace", () => {
    expect(hostFirstName({ firstName: "  John  " })).toBe("John");
  });

  it("falls back to first whitespace-delimited token of name", () => {
    expect(hostFirstName({ name: "John Anderson" })).toBe("John");
    expect(hostFirstName({ name: "Mary Jane Watson" })).toBe("Mary");
  });

  it("handles single-word names", () => {
    expect(hostFirstName({ name: "Madonna" })).toBe("Madonna");
  });

  it("handles tabs and multiple spaces in name", () => {
    expect(hostFirstName({ name: "John\tAnderson" })).toBe("John");
    expect(hostFirstName({ name: "John   Anderson" })).toBe("John");
  });

  it("treats empty firstName as missing and falls through to name", () => {
    expect(hostFirstName({ firstName: "", name: "Jane Doe" })).toBe("Jane");
    expect(hostFirstName({ firstName: "   ", name: "Jane Doe" })).toBe("Jane");
  });

  it("returns 'Host' fallback when both firstName and name are absent or empty", () => {
    expect(hostFirstName({})).toBe("Host");
    expect(hostFirstName({ firstName: null, name: null })).toBe("Host");
    expect(hostFirstName({ firstName: undefined, name: undefined })).toBe("Host");
    expect(hostFirstName({ name: "" })).toBe("Host");
    expect(hostFirstName({ name: "   " })).toBe("Host");
  });

  it("returns 'Host' fallback when input is null or undefined", () => {
    expect(hostFirstName(null)).toBe("Host");
    expect(hostFirstName(undefined)).toBe("Host");
  });

  it("never returns an empty string", () => {
    // Property: for any input, the result is non-empty.
    const inputs = [
      null,
      undefined,
      {},
      { firstName: null, name: null },
      { firstName: "", name: "" },
      { firstName: "  ", name: "  " },
      { firstName: "John" },
      { name: "John Doe" },
    ];
    for (const input of inputs) {
      const result = hostFirstName(input);
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
