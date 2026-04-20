/**
 * Roll up the attendee RSVP states on a calendar event into a single flag
 * used by the dashboard & availability weekly view to show a little person
 * icon on the tile.
 *
 * Rules (v1, confirmed with John 2026-04-19):
 *
 *   - "accepted"  — at least one non-host attendee has accepted. Wins over
 *                   everything; at least one confirmed human is coming.
 *   - "declined"  — every non-host attendee has declined. Strong signal the
 *                   meeting is effectively dead.
 *   - "pending"   — we have ≥1 non-host attendee, nobody accepted, not all
 *                   declined — i.e. at least one `needsAction` or
 *                   `tentative`. Tentative counts as pending in v1.
 *   - null        — no non-host attendees at all (solo block / self event).
 *
 * The host is identified by exact email match OR `self: true` on the
 * attendee entry (Google sets that flag on whichever attendee owns the
 * calendar being queried).
 */

export type AttendeeRollup = "accepted" | "declined" | "pending";

export interface AttendeeLike {
  email?: string | null;
  self?: boolean | null;
  responseStatus?: string | null;
}

export function rollupAttendeeStatus(
  attendees: AttendeeLike[] | null | undefined,
  hostEmail: string,
): AttendeeRollup | null {
  if (!attendees || attendees.length === 0) return null;

  const others = attendees.filter(
    (a) => !(a.self || (!!hostEmail && a.email === hostEmail)),
  );
  if (others.length === 0) return null;

  let anyAccepted = false;
  let allDeclined = true;

  for (const a of others) {
    if (a.responseStatus === "accepted") anyAccepted = true;
    if (a.responseStatus !== "declined") allDeclined = false;
  }

  if (anyAccepted) return "accepted";
  if (allDeclined) return "declined";
  return "pending";
}
