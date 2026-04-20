/**
 * Display-time status-label shaping.
 *
 * Sessions for links that no guest has engaged with yet ("pre-engagement")
 * should not show a `statusLabel` chip in the UI. Labels like "Waiting for
 * Sarah" or "Time change proposed by host" imply an active counterparty —
 * misleading when the link has never been shared or visited.
 *
 * We use a cheap heuristic (no DB query): status === "active" AND no
 * guestEmail AND no guestName. This covers the common case: a link was
 * created, Envoy updated its rules, but no one has confirmed, replied, or
 * even visited yet. Once a guest surfaces (via save_guest_info, a
 * participant row, or the confirm flow), guestEmail/guestName get populated
 * and we start showing labels again.
 *
 * Call at every API boundary that serves statusLabel to the client.
 */
export function displayStatusLabel(session: {
  status: string;
  statusLabel: string | null;
  guestEmail: string | null;
  guestName: string | null;
  /** Optional — when known, generic shared links suppress the label until
   *  the session actually reaches agreed. "Waiting for invitee" on a shared
   *  office-hours-style link is meaningless; there's no single invitee. */
  linkType?: string | null;
}): string | null {
  if (!session.statusLabel) return null;
  if (session.linkType === "generic" && session.status !== "agreed") return null;
  if (session.status !== "active") return session.statusLabel;
  if (session.guestEmail || session.guestName) return session.statusLabel;
  return null;
}
