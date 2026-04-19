import { describe, it, expect } from "vitest";
import { hashGuestEmail, maskGuestEmail } from "@/lib/mcp/email-hash";

describe("hashGuestEmail", () => {
  it("is stable for the same (salt, email)", () => {
    const a = hashGuestEmail("salt-A", "alex@example.com");
    const b = hashGuestEmail("salt-A", "alex@example.com");
    expect(a).toBe(b);
  });

  it("differs across links (different salts)", () => {
    const a = hashGuestEmail("salt-A", "alex@example.com");
    const b = hashGuestEmail("salt-B", "alex@example.com");
    expect(a).not.toBe(b);
  });

  it("normalizes case and whitespace", () => {
    const a = hashGuestEmail("salt", "Alex@Example.com");
    const b = hashGuestEmail("salt", "  alex@example.com  ");
    expect(a).toBe(b);
  });

  it("rejects empty salt", () => {
    expect(() => hashGuestEmail("", "alex@example.com")).toThrow(/empty salt/);
  });

  it("rejects malformed email", () => {
    expect(() => hashGuestEmail("salt", "no-at-sign")).toThrow(/invalid email/);
    expect(() => hashGuestEmail("salt", "@domain.com")).toThrow(/invalid email/);
    expect(() => hashGuestEmail("salt", "local@")).toThrow(/invalid email/);
  });
});

describe("maskGuestEmail", () => {
  it("preserves domain and first letter", () => {
    expect(maskGuestEmail("alex@example.com")).toBe("a***@example.com");
  });

  it("handles single-letter local part", () => {
    expect(maskGuestEmail("a@example.com")).toBe("*@example.com");
  });

  it("lowercases domain", () => {
    expect(maskGuestEmail("Alex@Example.COM")).toBe("a***@example.com");
  });
});
