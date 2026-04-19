/**
 * Per-link salted hash of a guest email, plus a domain-preserving mask for
 * debugging surfaces.
 *
 * SPEC §4.
 *
 *   hashGuestEmail(salt, email) = sha256(salt || localPart || "@" || domain)
 *
 * The salt is per-NegotiationLink (schema default `gen_random_uuid()::text`),
 * so a given guest email produces a different hash on every link. This
 * makes cross-link correlation infeasible while still letting a single
 * link de-duplicate its own guest.
 *
 * Mask format: `a***@example.com` — preserves the domain (safe in logs /
 * debugging UI) and the first letter of the local part (a hint for humans
 * reading logs who are triaging a specific user).
 */

import { createHash } from "node:crypto";

function splitEmail(email: string): { local: string; domain: string } {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    throw new Error("email-hash: invalid email (no local or no domain)");
  }
  return { local: trimmed.slice(0, at), domain: trimmed.slice(at + 1) };
}

/**
 * Per-link stable sha256 hex of a guest email.
 *
 * Throws if `salt` is empty (belt-and-braces — the schema default prevents
 * this in prod, but a mis-seeded row in a test fixture would silently
 * collapse into "unsalted" without this check).
 */
export function hashGuestEmail(salt: string, email: string): string {
  if (!salt) throw new Error("email-hash: empty salt");
  const { local, domain } = splitEmail(email);
  return createHash("sha256")
    .update(salt, "utf8")
    .update(local, "utf8")
    .update("@", "utf8")
    .update(domain, "utf8")
    .digest("hex");
}

/**
 * Domain-preserving mask. For `alex@example.com` → `a***@example.com`.
 * For single-letter local parts → `*@example.com`.
 */
export function maskGuestEmail(email: string): string {
  const { local, domain } = splitEmail(email);
  if (local.length <= 1) return `*@${domain}`;
  return `${local[0]}***@${domain}`;
}
