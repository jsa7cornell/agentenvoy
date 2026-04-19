import { describe, it, expect } from "vitest";
import { firstName } from "@/lib/mcp/principal";

describe("firstName", () => {
  it("returns the first whitespace-delimited token", () => {
    expect(firstName("Danny Lee")).toBe("Danny");
    expect(firstName("Alex Jane Doe")).toBe("Alex");
  });

  it("collapses whitespace runs", () => {
    expect(firstName("  Danny   Lee  ")).toBe("Danny");
    expect(firstName("Danny\tLee")).toBe("Danny");
  });

  it("returns null for empty / nullish input", () => {
    expect(firstName("")).toBeNull();
    expect(firstName("   ")).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(firstName(undefined)).toBeNull();
  });

  it("returns the whole string for single-token input", () => {
    expect(firstName("Cher")).toBe("Cher");
  });
});
