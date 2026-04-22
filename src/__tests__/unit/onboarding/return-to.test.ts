import { describe, it, expect } from "vitest";
import {
  validateReturnTo,
  onboardingCallbackUrl,
} from "@/lib/onboarding/return-to";

describe("validateReturnTo", () => {
  it("returns null for null/undefined/empty/non-string", () => {
    expect(validateReturnTo(null)).toBeNull();
    expect(validateReturnTo(undefined)).toBeNull();
    expect(validateReturnTo("")).toBeNull();
    expect(validateReturnTo(123 as unknown as string)).toBeNull();
  });

  it("accepts valid same-origin absolute paths", () => {
    expect(validateReturnTo("/dashboard")).toBe("/dashboard");
    expect(validateReturnTo("/meet/alice")).toBe("/meet/alice");
    expect(validateReturnTo("/meet/alice/abc?x=1")).toBe("/meet/alice/abc?x=1");
    expect(validateReturnTo("/")).toBe("/");
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(validateReturnTo("//evil.com")).toBeNull();
    expect(validateReturnTo("//evil.com/path")).toBeNull();
  });

  it("rejects absolute URLs with protocol", () => {
    expect(validateReturnTo("https://evil.com")).toBeNull();
    expect(validateReturnTo("http://evil.com/path")).toBeNull();
    expect(validateReturnTo("javascript:alert(1)")).toBeNull();
  });

  it("rejects relative paths without leading slash", () => {
    expect(validateReturnTo("dashboard")).toBeNull();
    expect(validateReturnTo("meet/alice")).toBeNull();
    expect(validateReturnTo("../escape")).toBeNull();
  });

  it("rejects paths containing backslashes (Windows path-confusion vectors)", () => {
    expect(validateReturnTo("/\\evil.com")).toBeNull();
    expect(validateReturnTo("/path\\back")).toBeNull();
  });
});

describe("onboardingCallbackUrl", () => {
  it("wraps an absolute path as an onboardReturnTo query on /dashboard", () => {
    expect(onboardingCallbackUrl("/meet/alice")).toBe(
      "/dashboard?onboardReturnTo=%2Fmeet%2Falice",
    );
  });

  it("URL-encodes special characters", () => {
    expect(onboardingCallbackUrl("/meet/alice?x=1&y=2")).toBe(
      "/dashboard?onboardReturnTo=%2Fmeet%2Falice%3Fx%3D1%26y%3D2",
    );
  });

  it("round-trips via validateReturnTo", () => {
    const original = "/meet/alice/abc?note=hi";
    const wrapped = onboardingCallbackUrl(original);
    const q = new URL(wrapped, "http://localhost").searchParams.get(
      "onboardReturnTo",
    );
    expect(validateReturnTo(q)).toBe(original);
  });
});
