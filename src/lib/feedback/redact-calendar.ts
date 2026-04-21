/**
 * Calendar event redactor for feedback bundles (F3 of the feedback-loops
 * proposal, 2026-04-20).
 *
 * Allowlist-enforced: the input `CalendarEvent` shape is already trimmed
 * (no description, attachments, or non-participant attendee emails — see
 * src/lib/calendar.ts). This redactor is the sink that the bundle builder
 * calls — its existence is the architectural commitment that calendar
 * data cannot enter a FeedbackReport.bundle without passing through here.
 *
 * Design decisions (reviewer blockers B1/B2):
 *   - Preserve attendee CARDINALITY via `attendees.count` — distinguishes
 *     "conflict with 1 other person" from "conflict with 30 other people"
 *     without leaking any emails.
 *   - Drop `htmlLink` because the URL embeds the eventId and calendarId.
 *   - Drop `location` if it looks like a URL (conference links etc.);
 *     literal room names pass through.
 *   - `agentenvoySessionId` is attached separately by the bundle builder,
 *     which does a sibling lookup on NegotiationSession.calendarEventId.
 *     Our CalendarCache shape doesn't carry extendedProperties from Google.
 */

import type { CalendarEvent } from "@/lib/calendar";

export interface RedactedCalendarEvent {
  id: string;
  iCalUID?: string;
  start: string; // ISO
  end: string; // ISO
  summary: string;
  eventType?: string;
  isAllDay: boolean;
  isRecurring: boolean;
  calendarName: string;
  location?: string; // only if NOT URL-shaped
  responseStatus?: string; // host's RSVP
  attendees: { count: number };
  /** Attached by the bundle builder when the event matches an
   *  AgentEnvoy-originated NegotiationSession. Debugging signal. */
  agentenvoySessionId?: string;
}

function looksLikeUrl(s: string): boolean {
  const trimmed = s.trim();
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("www.") ||
    // Zoom/Meet/Teams often carry bare hostnames
    /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(trimmed)
  );
}

export function redactCalendarEvent(event: CalendarEvent): RedactedCalendarEvent {
  const redacted: RedactedCalendarEvent = {
    id: event.id,
    iCalUID: event.iCalUID,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    summary: event.summary,
    eventType: event.eventType,
    isAllDay: event.isAllDay,
    isRecurring: event.isRecurring,
    calendarName: event.calendar,
    responseStatus: event.responseStatus,
    attendees: { count: event.attendeeCount ?? 0 },
  };

  if (event.location && !looksLikeUrl(event.location)) {
    redacted.location = event.location;
  }

  return redacted;
}
