/**
 * External-agent turn prefix at the LLM history assembly boundary.
 *
 * SPEC §5. The DB stores `Message.content` verbatim — the prefix is NOT
 * persisted. It is applied only when assembling the LLM message history
 * for the Host-Envoy's next turn, so the Host-Envoy sees e.g.:
 *
 *   [Acme Scheduler, acting for alex@example.org]: ...original text...
 *
 * while the guest-facing deal-room renders the unprefixed text.
 *
 * Why at the boundary, not at write-time:
 *   - Identity is a presentation concern of the LLM input channel. Mixing
 *     it into the DB would lie about the author's actual bytes.
 *   - If the identity of the external agent is later corrected (e.g. a
 *     mislabel at the MCP gateway), past messages reprefix correctly; no
 *     backfill migration needed.
 *   - Audit logs quote the DB content, so they stay clean.
 */

export type ExternalAgentIdentity = {
  /** Human-readable name of the calling agent (e.g. "Acme Scheduler"). */
  clientName: string;
  /** Masked email of the principal the agent acts for — see email-hash.ts maskGuestEmail(). */
  actingFor: string;
};

/**
 * Build the `[name, acting for email]: ` prefix. Returns an empty string
 * when identity is absent (defensive — a missing identity is a bug at the
 * gateway and should have been caught before here, but we don't want the
 * Host-Envoy prompt to crash).
 */
export function buildExternalAgentPrefix(
  identity: ExternalAgentIdentity | null | undefined,
): string {
  if (!identity) return "";
  const name = identity.clientName.trim();
  const actor = identity.actingFor.trim();
  if (!name || !actor) return "";
  return `[${name}, acting for ${actor}]: `;
}

/**
 * Prefix a verbatim message body for LLM assembly. Pure function — the DB
 * row is untouched.
 */
export function applyExternalAgentPrefix(
  body: string,
  identity: ExternalAgentIdentity | null | undefined,
): string {
  const prefix = buildExternalAgentPrefix(identity);
  return prefix ? `${prefix}${body}` : body;
}
