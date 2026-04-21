/**
 * agent-token (sign + verify) tests — proposals/2026-04-21 §2 + §6.
 *
 * Covers the pure crypto surface: signing, signature verification,
 * expiry check, secret rotation, and the closed ViewDeniedReason enum.
 * DB-bound gates (revoke, fetchCount cap) live in the route handler test;
 * this file is per-function, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  signAgentToken,
  verifyAgentTokenSignature,
  AGENT_TOKEN_AUDIENCE,
  AGENT_TOKEN_TTL_SECONDS,
  AGENT_TOKEN_FETCH_CAP,
} from "@/lib/feedback/agent-token";

const SECRET = "test-secret-at-least-sixteen-chars";
const SECRET_ALT = "alt-secret-at-least-sixteen-chars";

beforeEach(() => {
  vi.stubEnv("AGENT_TOKEN_SECRET", SECRET);
  vi.stubEnv("AGENT_TOKEN_SECRET_PREVIOUS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signAgentToken", () => {
  it("emits a JWT with aud, reportId, jti, iat, exp", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    const { token, jti, expiresAt } = signAgentToken({ reportId: "fr_1", now });
    expect(token.split(".")).toHaveLength(3);
    expect(jti).toMatch(/^[0-9a-f-]{36}$/i);
    expect(expiresAt.getTime() - now.getTime()).toBe(AGENT_TOKEN_TTL_SECONDS * 1000);

    const body = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
    expect(body.aud).toBe(AGENT_TOKEN_AUDIENCE);
    expect(body.reportId).toBe("fr_1");
    expect(body.jti).toBe(jti);
    expect(body.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(body.exp).toBe(body.iat + AGENT_TOKEN_TTL_SECONDS);
  });

  it("refuses short secrets", () => {
    vi.stubEnv("AGENT_TOKEN_SECRET", "too-short");
    expect(() => signAgentToken({ reportId: "fr_1" })).toThrow(/too short/i);
  });
});

describe("verifyAgentTokenSignature", () => {
  it("verifies a freshly signed token", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    const { token, jti } = signAgentToken({ reportId: "fr_1", now });
    const result = verifyAgentTokenSignature(token, { now });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.reportId).toBe("fr_1");
      expect(result.claims.jti).toBe(jti);
      expect(result.claims.aud).toBe(AGENT_TOKEN_AUDIENCE);
    }
  });

  it("returns bad_signature for tampered body", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    const { token } = signAgentToken({ reportId: "fr_1", now });
    const [h, , s] = token.split(".");
    const tampered = `${h}.${Buffer.from('{"aud":"agent-feedback","reportId":"fr_EVIL","jti":"x","iat":1,"exp":9999999999}').toString("base64url")}.${s}`;
    const result = verifyAgentTokenSignature(tampered, { now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("returns bad_signature for wrong secret", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    const { token } = signAgentToken({ reportId: "fr_1", now });
    vi.stubEnv("AGENT_TOKEN_SECRET", SECRET_ALT);
    const result = verifyAgentTokenSignature(token, { now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("returns expired for past exp", () => {
    const signedAt = new Date("2026-04-21T12:00:00Z");
    const { token } = signAgentToken({ reportId: "fr_1", now: signedAt });
    const laterThanTtl = new Date(signedAt.getTime() + (AGENT_TOKEN_TTL_SECONDS + 1) * 1000);
    const result = verifyAgentTokenSignature(token, { now: laterThanTtl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("accepts tokens signed with PREVIOUS secret during rotation", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    vi.stubEnv("AGENT_TOKEN_SECRET", SECRET);
    const { token } = signAgentToken({ reportId: "fr_1", now });

    // Rotate: new is SECRET_ALT, previous is SECRET
    vi.stubEnv("AGENT_TOKEN_SECRET", SECRET_ALT);
    vi.stubEnv("AGENT_TOKEN_SECRET_PREVIOUS", SECRET);
    const result = verifyAgentTokenSignature(token, { now });
    expect(result.ok).toBe(true);
  });

  it("rejects tokens signed with the rotated-out secret when PREVIOUS is unset (compromise flip)", () => {
    const now = new Date("2026-04-21T12:00:00Z");
    vi.stubEnv("AGENT_TOKEN_SECRET", SECRET);
    const { token } = signAgentToken({ reportId: "fr_1", now });

    vi.stubEnv("AGENT_TOKEN_SECRET", SECRET_ALT);
    vi.stubEnv("AGENT_TOKEN_SECRET_PREVIOUS", "");
    const result = verifyAgentTokenSignature(token, { now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("returns bad_signature for malformed token", () => {
    const result = verifyAgentTokenSignature("not-a-jwt", {
      now: new Date("2026-04-21T12:00:00Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });
});

describe("constants", () => {
  it("pins TTL to 15 minutes and fetch cap to 10", () => {
    expect(AGENT_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(AGENT_TOKEN_FETCH_CAP).toBe(10);
  });
});
