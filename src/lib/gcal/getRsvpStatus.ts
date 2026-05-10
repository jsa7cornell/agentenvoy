/**
 * getRsvpStatus — single source of truth for deriving GoogleCalendarStatus
 * (the prop shape consumed by MeetingCardCalendarRow + MeetingCardActions).
 *
 * AP5c readiness: this function is the future MCP `get_rsvp_status` derivation
 * point. Per spec § 6.1, RSVP exposure on the wire requires AP5c parity tests
 * routing through the SAME helper as the deal-room renderer. Keeping this
 * function pure + extractable now means a future MCP exposure proposal can
 * call it directly without re-deriving.
 *
 * Inputs:
 *   - `eventStatus`: result of `getCalendarEventStatus()` from `lib/calendar.ts`
 *     (always fetched server-side using the host's stored credentials)
 *   - `viewerEmail`: the requesting viewer's email (host or guest)
 *   - `viewerRole`: "host" | "guest" — drives which RSVP slot is populated
 *   - `inviteSentAt`: when the GCal invite was sent (used to surface "Nudge" affordance for stale host views)
 *   - `connectPromptEligible`: true when viewer is registered but no GCal connected
 *
 * Returns the GoogleCalendarStatus shape used by MeetingCardProps.
 *
 * See:
 *   - previews/event-card-FINAL-spec.md § 3.14 (CalendarRow rendering)
 *   - previews/event-card-FINAL-spec.md § 5 (GoogleCalendarStatus type)
 *   - previews/event-card-FINAL-spec.md § 6.1 (AP5c pre-commit)
 */

import type { GoogleCalendarStatus } from "@/components/MeetingCard/types";

type GCalAttendeeStatus = "needsAction" | "accepted" | "tentative" | "declined";

interface CalendarEventStatusInput {
  eventExists: boolean;
  guestEmail: string | null;
  guestOnInvite: boolean;
  guestResponseStatus: GCalAttendeeStatus | null;
  allAttendees: Array<{ email: string; responseStatus: GCalAttendeeStatus; self?: boolean }>;
  htmlLink?: string | null;
}

export interface RsvpStatusInput {
  eventStatus: CalendarEventStatusInput;
  viewerEmail: string | null;
  viewerRole: "host" | "guest";
  inviteSentAt?: Date;
  connectPromptEligible: boolean;
}

export function getRsvpStatus(input: RsvpStatusInput): GoogleCalendarStatus | null {
  const { eventStatus, viewerEmail, viewerRole, inviteSentAt, connectPromptEligible } = input;

  // No GCal event = no status to surface
  if (!eventStatus.eventExists || !eventStatus.htmlLink) {
    return null;
  }

  if (viewerRole === "host") {
    // Host view inverts: surface the GUEST's RSVP, not the host's own.
    return {
      eventUrl: eventStatus.htmlLink,
      viewerStatus: null, // host's own status is implicit (always accepted as organizer)
      otherPartyStatus: eventStatus.guestResponseStatus ?? undefined,
      inviteSentAt,
      connectPromptEligible: false, // host always has a connected calendar
    };
  }

  // Guest view: viewerStatus is what the requesting guest's RSVP looks like
  // in the host's GCal copy of the event.
  let viewerStatus: GCalAttendeeStatus | null = null;
  if (viewerEmail) {
    const viewerAttendee = eventStatus.allAttendees.find(
      (a) => a.email.toLowerCase() === viewerEmail.toLowerCase()
    );
    viewerStatus = viewerAttendee?.responseStatus ?? null;
  }

  return {
    eventUrl: eventStatus.htmlLink,
    viewerStatus,
    otherPartyStatus: undefined, // guest views their own status, not the host's
    connectPromptEligible,
  };
}
