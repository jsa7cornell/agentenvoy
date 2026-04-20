/**
 * Helpers for building deep links into Google Calendar's web UI.
 *
 * Google Calendar events can be viewed/edited in the browser via an `eid`
 * query param on calendar.google.com. The eid is base64url(eventId + " " +
 * calendarId), typically against `primary` / the user's own email. This
 * module centralizes the encoding so popup CTAs ("View/Reschedule in
 * Google") don't have to reinvent it.
 *
 * We don't control Google's URL scheme — they've quietly shipped both
 * `/r?eid=` and `/event?eid=` forms historically. We use `/r?eid=` since
 * that's what Google's own "View in Calendar" links serve today, but if
 * that flips we only need to touch one file.
 *
 * Non-Envoy events (e.g. an event the host created directly in Google
 * that AE discovered via the calendar cache) can also be linked via the
 * same helper — pass the event id and the hosting calendar id, and the
 * user lands on the correct event in Google's UI.
 */

/**
 * Build a Google Calendar web URL for an event.
 *
 * @param eventId Google Calendar event ID (what we persist as `calendarEventId`).
 * @param calendarId Calendar ID the event lives in. Defaults to "primary" —
 *                   Google resolves this against the currently-signed-in
 *                   account. Pass the explicit calendar email for
 *                   cross-calendar cases (shared calendars, etc.).
 * @returns URL string, or null if eventId is empty.
 */
export function googleCalendarEventUrl(
  eventId: string | null | undefined,
  calendarId: string = "primary",
): string | null {
  if (!eventId) return null;
  const eid = encodeGoogleCalendarEid(eventId, calendarId);
  return `https://calendar.google.com/calendar/r?eid=${eid}`;
}

/**
 * Google's `eid` param is base64url(`<eventId> <calendarId>`). Spaces get
 * encoded per base64url (no padding, url-safe alphabet). Exposed for tests
 * and for any caller that needs the raw eid.
 */
export function encodeGoogleCalendarEid(
  eventId: string,
  calendarId: string = "primary",
): string {
  const raw = `${eventId} ${calendarId}`;
  // Node's Buffer → base64 → convert to base64url (replace +/ with -_,
  // strip =). Works in Node and Edge runtimes (Next.js 14).
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(raw, "utf8").toString("base64")
      : // Edge / browser fallback
        btoa(unescape(encodeURIComponent(raw)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
