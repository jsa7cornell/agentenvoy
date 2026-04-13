/**
 * Stub calendar data for dev/test users without Google Calendar.
 * Used during onboarding to provide realistic events for the scoring demo.
 * Only served when NODE_ENV !== "production" and user has no Google Account.
 */

import { CalendarEvent } from "../calendar";
import { ScoredSlot } from "../scoring";

/** Generate stub events relative to "today" so they always look current */
function getStubEvents(): CalendarEvent[] {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  // Find next Monday (or today if Monday)
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((1 - dayOfWeek + 7) % 7 || 7));
  if (dayOfWeek === 1) monday.setDate(now.getDate()); // today is Monday

  function dayAt(dayOffset: number, hour: number, minute = 0): Date {
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  return [
    // Monday
    {
      id: "stub-1",
      summary: "Team Standup",
      start: dayAt(0, 9, 0),
      end: dayAt(0, 9, 30),
      calendar: "Work",
      provider: "stub",
      attendeeCount: 5,
      responseStatus: "accepted",
      isAllDay: false,
      isRecurring: true,
    },
    {
      id: "stub-2",
      summary: "Focus Time",
      start: dayAt(0, 14, 0),
      end: dayAt(0, 16, 0),
      calendar: "Work",
      provider: "stub",
      isAllDay: false,
      isRecurring: true,
      eventType: "focusTime",
    },
    // Tuesday
    {
      id: "stub-3",
      summary: "1:1 with Alex",
      start: dayAt(1, 10, 0),
      end: dayAt(1, 10, 30),
      calendar: "Work",
      provider: "stub",
      attendeeCount: 1,
      responseStatus: "accepted",
      isAllDay: false,
      isRecurring: true,
    },
    {
      id: "stub-4",
      summary: "Lunch with Sarah",
      start: dayAt(1, 12, 0),
      end: dayAt(1, 13, 0),
      calendar: "Work",
      provider: "stub",
      location: "Café Roma",
      attendeeCount: 1,
      responseStatus: "accepted",
      isAllDay: false,
      isRecurring: false,
    },
    // Wednesday
    {
      id: "stub-5",
      summary: "Focus Time",
      start: dayAt(2, 14, 0),
      end: dayAt(2, 16, 0),
      calendar: "Work",
      provider: "stub",
      isAllDay: false,
      isRecurring: true,
      eventType: "focusTime",
    },
    {
      id: "stub-6",
      summary: "Product Review",
      start: dayAt(2, 11, 0),
      end: dayAt(2, 12, 0),
      calendar: "Work",
      provider: "stub",
      attendeeCount: 4,
      responseStatus: "accepted",
      isAllDay: false,
      isRecurring: false,
    },
    // Thursday
    {
      id: "stub-7",
      summary: "Team Standup",
      start: dayAt(3, 9, 0),
      end: dayAt(3, 9, 30),
      calendar: "Work",
      provider: "stub",
      attendeeCount: 5,
      responseStatus: "accepted",
      isAllDay: false,
      isRecurring: true,
    },
    {
      id: "stub-8",
      summary: "Dentist Appointment",
      start: dayAt(3, 15, 0),
      end: dayAt(3, 16, 0),
      calendar: "Personal",
      provider: "stub",
      isAllDay: false,
      isRecurring: false,
    },
    // Friday
    {
      id: "stub-9",
      summary: "1:1 with Alex",
      start: dayAt(4, 10, 0),
      end: dayAt(4, 10, 30),
      calendar: "Work",
      provider: "stub",
      attendeeCount: 1,
      responseStatus: "accepted",
      isAllDay: false,
      isRecurring: true,
    },
  ];
}

/** Generate scored slots for a 2-week window with realistic scores */
export function getStubSchedule(timezone: string): {
  slots: ScoredSlot[];
  events: CalendarEvent[];
  timezone: string;
  connected: boolean;
  canWrite: boolean;
  calendars: string[];
} {
  const events = getStubEvents();
  const slots: ScoredSlot[] = [];
  const now = new Date();

  // Generate slots for 14 days, 7am-9pm, 30-min intervals
  for (let day = 0; day < 14; day++) {
    const date = new Date(now);
    date.setDate(now.getDate() + day);
    const dayOfWeek = date.getDay();

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    for (let hour = 7; hour < 21; hour++) {
      for (const minute of [0, 30]) {
        const start = new Date(date);
        start.setHours(hour, minute, 0, 0);
        const end = new Date(start);
        end.setMinutes(end.getMinutes() + 30);

        // Check if any event overlaps this slot
        const overlapping = events.find(
          (e) => e.start < end && e.end > start
        );

        let score: number;
        let confidence: "high" | "low" = "high";
        let reason: string;
        let eventSummary: string | undefined;

        if (overlapping) {
          eventSummary = overlapping.summary;
          if (overlapping.eventType === "focusTime") {
            score = 2;
            confidence = "low";
            reason = "Focus Time";
          } else if (overlapping.isRecurring && overlapping.attendeeCount === 1) {
            score = 3;
            confidence = "low";
            reason = `Recurring 1:1: ${overlapping.summary}`;
          } else if (overlapping.attendeeCount && overlapping.attendeeCount > 2) {
            score = 4;
            reason = `Group meeting: ${overlapping.summary}`;
          } else {
            score = 4;
            reason = overlapping.summary;
          }
        } else if (hour < 9 || hour >= 17) {
          // Outside business hours
          score = 4;
          reason = "Outside business hours";
        } else {
          // Open business hours
          score = 1;
          reason = "Open business hours";
        }

        slots.push({
          start: start.toISOString(),
          end: end.toISOString(),
          score,
          confidence,
          reason,
          eventSummary,
        });
      }
    }
  }

  return {
    slots,
    events,
    timezone,
    connected: true, // pretend connected so onboarding proceeds
    canWrite: false,
    calendars: ["Work", "Personal"],
  };
}
