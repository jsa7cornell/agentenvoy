import { describe, it, expect } from "vitest";
import {
  HOST_REQUIRED,
  GUEST_REQUIRED,
  HOST_WRITE_SCOPE,
  HOST_READ_SCOPE,
  auditScopes,
  parseScopeString,
} from "@/lib/oauth/required-scopes";

describe("parseScopeString", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(parseScopeString(null)).toEqual([]);
    expect(parseScopeString(undefined)).toEqual([]);
    expect(parseScopeString("")).toEqual([]);
  });

  it("splits on any whitespace and drops empties", () => {
    expect(parseScopeString("openid email   profile")).toEqual([
      "openid",
      "email",
      "profile",
    ]);
  });
});

describe("auditScopes — host", () => {
  it("satisfied when all HOST_REQUIRED scopes granted", () => {
    const scope = HOST_REQUIRED.join(" ");
    const a = auditScopes(scope, HOST_REQUIRED);
    expect(a.satisfied).toBe(true);
    expect(a.missingRequired).toEqual([]);
  });

  it("flags calendar.events missing when only readonly granted", () => {
    const scope = ["openid", "email", "profile", HOST_READ_SCOPE].join(" ");
    const a = auditScopes(scope, HOST_REQUIRED);
    expect(a.satisfied).toBe(false);
    expect(a.missingRequired).toContain(HOST_WRITE_SCOPE);
    expect(a.missingRequired).not.toContain(HOST_READ_SCOPE);
  });

  it("flags calendar.readonly missing when only events granted", () => {
    const scope = ["openid", "email", "profile", HOST_WRITE_SCOPE].join(" ");
    const a = auditScopes(scope, HOST_REQUIRED);
    expect(a.satisfied).toBe(false);
    expect(a.missingRequired).toContain(HOST_READ_SCOPE);
  });

  it("flags openid missing when omitted", () => {
    const scope = [
      "email",
      "profile",
      HOST_READ_SCOPE,
      HOST_WRITE_SCOPE,
    ].join(" ");
    const a = auditScopes(scope, HOST_REQUIRED);
    expect(a.satisfied).toBe(false);
    expect(a.missingRequired).toContain("openid");
  });

  it("returns all required as missing for null scope", () => {
    const a = auditScopes(null, HOST_REQUIRED);
    expect(a.satisfied).toBe(false);
    expect(a.missingRequired).toEqual([...HOST_REQUIRED]);
  });
});

describe("auditScopes — guest", () => {
  it("satisfied with read-only + openid", () => {
    const scope = GUEST_REQUIRED.join(" ");
    expect(auditScopes(scope, GUEST_REQUIRED).satisfied).toBe(true);
  });

  it("flags calendar.readonly missing when guest unticked it", () => {
    const scope = ["openid", "email", "profile"].join(" ");
    const a = auditScopes(scope, GUEST_REQUIRED);
    expect(a.satisfied).toBe(false);
    expect(a.missingRequired).toContain(HOST_READ_SCOPE);
  });
});
