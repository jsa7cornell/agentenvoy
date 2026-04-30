/**
 * Host-side MCP bearer auth.
 *
 * PAT format: `agentenvoy_pat_live_<32-byte-base62>`
 * The token is stored as SHA-256(plaintext) in HostAccessToken.tokenHash.
 * Scope is checked at the dispatch boundary — this module only resolves
 * identity and revocation.
 */
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";

export type HostScope = "read" | "schedule" | "admin";

export type HostPrincipalContext =
  | {
      ok: true;
      kind: "host_pat";
      userId: string;
      tokenId: string;
      displayId: string;
      scopes: ReadonlyArray<HostScope>;
    }
  | { ok: false; reason: HostAuthRefusal };

export type HostAuthRefusal =
  | "missing_bearer"
  | "malformed_bearer"
  | "token_not_found"
  | "token_revoked"
  | "token_expired";

const PAT_PREFIX = "agentenvoy_pat_live_";

export async function authorizeHostMcpCall(
  authorizationHeader: string | null,
): Promise<HostPrincipalContext> {
  if (!authorizationHeader) return { ok: false, reason: "missing_bearer" };

  const parts = authorizationHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return { ok: false, reason: "malformed_bearer" };
  }
  const plaintext = parts[1];
  if (!plaintext.startsWith(PAT_PREFIX)) {
    // Wrong prefix — token_not_found (don't leak whether format was right)
    return { ok: false, reason: "token_not_found" };
  }

  const tokenHash = createHash("sha256").update(plaintext).digest("hex");

  const token = await prisma.hostAccessToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      displayId: true,
      scopes: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!token) return { ok: false, reason: "token_not_found" };
  if (token.revokedAt) return { ok: false, reason: "token_revoked" };
  if (token.expiresAt && token.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "token_expired" };
  }

  // Lazy lastUsedAt update — debounced to avoid write on every call.
  // Fire-and-forget; don't await.
  void prisma.hostAccessToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    ok: true,
    kind: "host_pat",
    userId: token.userId,
    tokenId: token.id,
    displayId: token.displayId,
    scopes: token.scopes as HostScope[],
  };
}

/**
 * Scope cascade: admin ⊇ schedule ⊇ read.
 * A token with ["schedule"] implicitly satisfies "read".
 */
export function hasScope(
  issued: ReadonlyArray<HostScope>,
  required: HostScope,
): boolean {
  if (issued.includes("admin")) return true;
  if (required === "read") return issued.includes("read") || issued.includes("schedule");
  if (required === "schedule") return issued.includes("schedule");
  return false; // admin requires admin
}
