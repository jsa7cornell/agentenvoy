import { describe, it, expect } from "vitest";
import type { CalendarEvent } from "@/lib/calendar";
import { redactCalendarEvent } from "@/lib/feedback/redact-calendar";

function baseEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt_1",
    iCalUID: "uid-1@google.com",
    summary: "Design sync",
    start: new Date("2026-04-20T15:00:00Z"),
    end: new Date("2026-04-20T16:00:00Z"),
    calendar: "Work",
    provider: "google",
    isAllDay: false,
    isRecurring: false,
    attendeeCount: 3,
    responseStatus: "accepted",
    ...overrides,
  };
}

describe("redactCalendarEvent", () => {
  it("preserves allowlisted fields (id, iCalUID, times, summary, calendar, RSVP, cardinality)", () => {
    const redacted = redactCalendarEvent(baseEvent());
    expect(redacted).toMatchObject({
      id: "evt_1",
      iCalUID: "uid-1@google.com",
      summary: "Design sync",
      start: "2026-04-20T15:00:00.000Z",
      end: "2026-04-20T16:00:00.000Z",
      calendarName: "Work",
      responseStatus: "accepted",
      isAllDay: false,
      isRecurring: false,
      attendees: { count: 3 },
    });
  });

  it("preserves attendee cardinality but never emails — even if attendeeCount is 0, emits 0", () => {
    const redacted = redactCalendarEvent(baseEvent({ attendeeCount: undefined }));
    expect(redacted.attendees).toEqual({ count: 0 });
  });

  it("drops URL-shaped location (https, http, www, bare host/path)", () => {
    const cases = [
      "https://zoom.us/j/123",
      "http://meet.google.com/abc-defg-hij",
      "www.webex.com/meet/foo",
      "teams.microsoft.com/l/meetup-join/XYZ",
    ];
    for (const loc of cases) {
      const redacted = redactCalendarEvent(baseEvent({ location: loc }));
      expect(redacted.location, `should drop ${loc}`).toBeUndefined();
    }
  });

  it("passes through literal room-name locations", () => {
    const redacted = redactCalendarEvent(baseEvent({ location: "Conference Room A" }));
    expect(redacted.location).toBe("Conference Room A");
  });

  it("does not carry an agentenvoySessionId — that is attached by the bundle builder", () => {
    const redacted = redactCalendarEvent(baseEvent());
    expect(redacted.agentenvoySessionId).toBeUndefined();
  });

  it("does not leak attachments, htmlLink, recurringEventId, or any non-allowlisted field", () => {
    const event = baseEvent({
      htmlLink: "https://calendar.google.com/calendar/u/0/r/eventedit/SECRET",
      recurringEventId: "parent_event_123",
      isTransparent: true,
    });
    const redacted = redactCalendarEvent(event);
    const keys = Object.keys(redacted);
    expect(keys).not.toContain("htmlLink");
    expect(keys).not.toContain("recurringEventId");
    expect(keys).not.toContain("isTransparent");
    expect(keys).not.toContain("provider");
  });

  it("passes eventType through when present", () => {
    const redacted = redactCalendarEvent(baseEvent({ eventType: "outOfOffice" }));
    expect(redacted.eventType).toBe("outOfOffice");
  });
});
