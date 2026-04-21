/**
 * Agent-accessible feedback token infrastructure
 * (proposals/2026-04-21_agent-accessible-feedback-pipeline §2 + §6).
 *
 * HS256 JWT signed with AGENT_TOKEN_SECRET, aud "agent-feedback", 15-min TTL,
 * 10-fetch cap. Every mint writes an AgentAccessToken row keyed by `jti`;
 * every verify looks up that row and checks revoked / used / fetchCount
 * before incrementing.
 *
 * Rotation (§6.2):
 *   - Hygiene — set AGENT_TOKEN_SECRET_PREVIOUS to the outgoing secret;
 *     verify tries current then previous. Drop PREVIOUS after the TTL
 *     window has drained (15 min).
 *   - Compromise — flip AGENT_TOKEN_SECRET, leave PREVIOUS unset. All
 *     in-flight tokens die immediately.
 *
 * PII posture: this module doesn't touch report bodies. It only mints +
 * verifies. The bundle comes from bundle-builder.ts via the caller.
 */

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

export const AGENT_TOKEN_AUDIENCE = "agent-feedback";
export const AGENT_TOKEN_TTL_SECONDS = 15 * 60;
export const AGENT_TOKEN_FETCH_CAP = 10;

export type ViewDeniedReason =
  | "bad_signature"
  | "reportid_mismatch"
  | "expired"
  | "revoked"
  | "rate_limited"
  | "token_not_found";

export interface AgentTokenClaims {
  reportId: string;
  jti: string;
  aud: string;
  exp: number;
  iat: number;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function getSecrets(): { current: string; previous: string | null } {
  const current = process.env.AGENT_TOKEN_SECRET;
  if (!current || current.length < 16) {
    throw new Error(
      "AGENT_TOKEN_SECRET is not set or too short (minimum 16 chars). " +
        "Add to Vercel env and 1Password Secrets vault.",
    );
  }
  const previous = process.env.AGENT_TOKEN_SECRET_PREVIOUS || null;
  return { current, previous };
}

function sign(payload: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(payload).digest();
  return b64url(mac);
}

function signingInput(header: string, body: string): string {
  return `${header}.${body}`;
}

export interface MintTokenInput {
  reportId: string;
  /** now() injected for tests. */
  now?: Date;
}

export interface MintTokenOutput {
  token: string;
  jti: string;
  expiresAt: Date;
}

/**
 * Pure sign. Does NOT write to the DB. The caller writes the AgentAccessToken
 * row so mint-endpoint rate-limiting + audit logging stay in one place.
 */
export function signAgentToken(input: MintTokenInput): MintTokenOutput {
  const { current } = getSecrets();
  const iat = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const exp = iat + AGENT_TOKEN_TTL_SECONDS;
  const jti = randomUUID();

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      aud: AGENT_TOKEN_AUDIENCE,
      reportId: input.reportId,
      jti,
      iat,
      exp,
    }),
  );
  const sig = sign(signingInput(header, body), current);
  return {
    token: `${header}.${body}.${sig}`,
    jti,
    expiresAt: new Date(exp * 1000),
  };
}

export type VerifyResult =
  | { ok: true; claims: AgentTokenClaims }
  | { ok: false; reason: ViewDeniedReason };

/**
 * Pure verify — signature + aud + exp. Does NOT look up the DB row; the
 * caller checks revoke/used/fetchCount against AgentAccessToken.
 */
export function verifyAgentTokenSignature(
  token: string,
  opts?: { now?: Date },
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "bad_signature" };
  const [header, body, providedSig] = parts;

  let secrets: { current: string; previous: string | null };
  try {
    secrets = getSecrets();
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  const expectedCurrent = sign(signingInput(header, body), secrets.current);
  const provided = b64urlDecode(providedSig);
  const expectedCurrentBuf = b64urlDecode(expectedCurrent);
  let matched = false;
  if (provided.length === expectedCurrentBuf.length && timingSafeEqual(provided, expectedCurrentBuf)) {
    matched = true;
  } else if (secrets.previous) {
    const expectedPrev = sign(signingInput(header, body), secrets.previous);
    const expectedPrevBuf = b64urlDecode(expectedPrev);
    if (provided.length === expectedPrevBuf.length && timingSafeEqual(provided, expectedPrevBuf)) {
      matched = true;
    }
  }
  if (!matched) return { ok: false, reason: "bad_signature" };

  let claims: AgentTokenClaims;
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (
      typeof parsed.reportId !== "string" ||
      typeof parsed.jti !== "string" ||
      parsed.aud !== AGENT_TOKEN_AUDIENCE ||
      typeof parsed.exp !== "number" ||
      typeof parsed.iat !== "number"
    ) {
      return { ok: false, reason: "bad_signature" };
    }
    claims = parsed;
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  const nowSec = Math.floor((opts?.now?.getTime() ?? Date.now()) / 1000);
  if (claims.exp <= nowSec) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}
