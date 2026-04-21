/**
 * Stage 1 live-sync primitives for the deal-room widget.
 *
 * See proposal:
 *   proposals/2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity_reviewed-2026-04-21_decided-2026-04-21.md
 * §8.4 (B1 fold) — client-only hybrid: suppress poll while streaming, then
 * content-matched id-swap on merge.
 *
 * These are pure helpers extracted from `deal-room.tsx` so they can be
 * unit-tested without spinning up the whole component.
 */

export interface LiveSyncMessage {
  id: string;
  role: string;
  content: string;
  metadata?: unknown;
  createdAt?: string;
}

/**
 * Detects client-generated temp ids. `handleSend` assigns temp ids via
 * `Date.now().toString()` and `(Date.now() + 1).toString()` for the user
 * bubble and the streamed-assistant bubble respectively. Server ids from
 * Prisma are CUIDs / similar opaque strings.
 *
 * Rule: a temp id is a numeric string whose numeric value is a plausible
 * ms-since-epoch timestamp (> 2023-11-14 ≈ 1_700_000_000_000). That rules
 * out "greeting", "error-…", "directive-…", CUIDs, UUIDs, etc.
 *
 * Kept deliberately narrow — any server id that happened to be a numeric
 * string would be a false positive, which would mis-classify a real
 * server record as "temp". Prisma never generates such ids.
 */
export function isTempId(id: string): boolean {
  if (!id) return false;
  if (!/^\d+$/.test(id)) return false;
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  return n > 1_700_000_000_000;
}

/**
 * Merge server-authoritative poll results into local state.
 *
 * - If a local message has a temp id and content-matches an incoming
 *   server message on `(role + createdAt within 5s + content exact)`,
 *   replace the temp-id local message in place with the server record.
 *   This is the mid-stream / post-stream dedup path — it's why we don't
 *   need a server-id handshake (B1 rejected alternative).
 * - Otherwise: dedupe by server id. If the server id isn't already in
 *   local state, append it. If it is, leave it alone (server is
 *   authoritative for persisted content / metadata).
 * - A second poll arriving before a temp-id row has been swapped is
 *   handled by the same content-match pass: each incoming server row
 *   looks for a temp-id twin first, then falls through to id dedup.
 *
 * Preserves local-message order. Appended server messages go to the end
 * in the order they arrive in `serverMessages` (which the endpoint
 * returns `orderBy: createdAt asc`).
 */
export function mergePollResult(
  localMessages: LiveSyncMessage[],
  serverMessages: LiveSyncMessage[],
): LiveSyncMessage[] {
  const next = localMessages.slice();
  const CONTENT_MATCH_WINDOW_MS = 5000;

  for (const serverMsg of serverMessages) {
    // Content-match against any temp-id local row first.
    const tempIdx = next.findIndex((local) => {
      if (!isTempId(local.id)) return false;
      if (local.role !== serverMsg.role) return false;
      if (local.content !== serverMsg.content) return false;
      // createdAt is optional on the local side; if missing, accept the
      // content+role match (common for the user-bubble path where we
      // don't stamp createdAt on the optimistic row).
      if (!local.createdAt || !serverMsg.createdAt) return true;
      const localTs = new Date(local.createdAt).getTime();
      const serverTs = new Date(serverMsg.createdAt).getTime();
      if (!Number.isFinite(localTs) || !Number.isFinite(serverTs)) return true;
      return Math.abs(localTs - serverTs) < CONTENT_MATCH_WINDOW_MS;
    });

    if (tempIdx !== -1) {
      // Swap in place — same index, server-authoritative id + metadata.
      next[tempIdx] = {
        id: serverMsg.id,
        role: serverMsg.role,
        content: serverMsg.content,
        metadata: serverMsg.metadata ?? null,
        createdAt: serverMsg.createdAt,
      };
      continue;
    }

    // Dedup by server id.
    const idHit = next.find((m) => m.id === serverMsg.id);
    if (idHit) continue;

    next.push({
      id: serverMsg.id,
      role: serverMsg.role,
      content: serverMsg.content,
      metadata: serverMsg.metadata ?? null,
      createdAt: serverMsg.createdAt,
    });
  }

  return next;
}
