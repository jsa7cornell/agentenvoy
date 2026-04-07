import { google, calendar_v3 } from "googleapis";
import { prisma } from "./prisma";

// --- Calendar Provider Abstraction ---

export interface CalendarProvider {
  readonly type: string; // "google", "ical", "outlook"
  readonly canWrite: boolean;
  getEvents(start: Date, end: Date): Promise<CalendarEvent[]>;
  createEvent(params: CreateEventParams): Promise<EventResult>;
  listCalendars(): Promise<Array<{ id: string; name: string }>>;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  calendar: string; // calendar name (e.g., "Jack's Schedule", "Work")
  provider: string; // provider type (e.g., "google", "ical", "outlook")
  location?: string;
  attendeeCount?: number;
  responseStatus?: string; // host's RSVP: "accepted", "declined", "tentative", "needsAction"
  isAllDay: boolean;
  isRecurring: boolean;
  isTransparent?: boolean; // "transparent" events don't block time (FYI only)
}

export interface CreateEventParams {
  summary: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  attendeeEmails: string[];
  addMeetLink?: boolean;
}

export interface EventResult {
  eventId?: string | null;
  htmlLink?: string | null;
  meetLink?: string | null;
}

export interface CalendarContext {
  connected: boolean;
  events: CalendarEvent[];
  calendars: string[];
  timezone: string;
  canWrite: boolean;
  hostLocation?: string; // future: from device, for now: inferred from events/knowledge
}

// --- Google Calendar Provider ---

class GoogleCalendarProvider implements CalendarProvider {
  readonly type = "google";
  readonly canWrite = true;
  private client: calendar_v3.Calendar;
  private hostEmail: string;

  constructor(client: calendar_v3.Calendar, hostEmail: string) {
    this.client = client;
    this.hostEmail = hostEmail;
  }

  async listCalendars(): Promise<Array<{ id: string; name: string }>> {
    const { data } = await this.client.calendarList.list();
    return (data.items ?? []).map((c) => ({
      id: c.id || "primary",
      name: c.summary || c.id || "primary",
    }));
  }

  async getEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const calendars = await this.listCalendars();
    const allEvents: CalendarEvent[] = [];

    for (const cal of calendars) {
      try {
        const { data } = await this.client.events.list({
          calendarId: cal.id,
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 100,
        });

        for (const ev of data.items ?? []) {
          const isAllDay = !ev.start?.dateTime;
          const evStart = isAllDay
            ? new Date(ev.start?.date + "T00:00:00")
            : new Date(ev.start!.dateTime!);
          const evEnd = isAllDay
            ? new Date(ev.end?.date + "T00:00:00")
            : new Date(ev.end!.dateTime!);

          // Find host's RSVP status from attendees list
          const hostAttendee = ev.attendees?.find(
            (a) => a.email === this.hostEmail || a.self
          );

          allEvents.push({
            id: ev.id || crypto.randomUUID(),
            summary: ev.summary || "(no title)",
            start: evStart,
            end: evEnd,
            calendar: cal.name,
            provider: "google",
            location: ev.location || undefined,
            attendeeCount: ev.attendees?.length ?? 0,
            responseStatus: hostAttendee?.responseStatus || undefined,
            isAllDay,
            isRecurring: !!ev.recurringEventId,
            isTransparent: ev.transparency === "transparent",
          });
        }
      } catch (e) {
        console.log(`Failed to fetch events for calendar ${cal.name}:`, e);
      }
    }

    return allEvents;
  }

  async createEvent(params: CreateEventParams): Promise<EventResult> {
    const event = {
      summary: params.summary,
      description: params.description,
      start: { dateTime: params.startTime.toISOString() },
      end: { dateTime: params.endTime.toISOString() },
      attendees: params.attendeeEmails.map((email) => ({ email })),
      ...(params.addMeetLink && {
        conferenceData: {
          createRequest: {
            requestId: `agentenvoy-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
    };

    const { data } = await this.client.events.insert({
      calendarId: "primary",
      requestBody: event,
      conferenceDataVersion: params.addMeetLink ? 1 : 0,
      sendUpdates: "all",
    });

    return {
      eventId: data.id,
      htmlLink: data.htmlLink,
      meetLink: data.conferenceData?.entryPoints?.find(
        (e) => e.entryPointType === "video"
      )?.uri,
    };
  }
}

// --- Provider registry ---

async function getProviders(userId: string): Promise<CalendarProvider[]> {
  const providers: CalendarProvider[] = [];

  // Google
  try {
    const account = await prisma.account.findFirst({
      where: { userId, provider: "google" },
      select: { providerAccountId: true },
    });
    const hostEmail = account?.providerAccountId
      ? (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email || ""
      : "";
    const client = await getGoogleCalendarClient(userId);
    providers.push(new GoogleCalendarProvider(client, hostEmail));
  } catch {
    // No Google account connected — that's ok
  }

  // Future: iCal (read-only URL subscription), Outlook (Microsoft Graph), CalDAV
  // Each would be a new class implementing CalendarProvider

  return providers;
}

// --- Main context function ---

export async function getCalendarContext(
  userId: string,
  startDate: Date,
  endDate: Date,
  timezone = "America/Los_Angeles"
): Promise<CalendarContext> {
  const providers = await getProviders(userId);

  if (providers.length === 0) {
    return {
      connected: false,
      events: [],
      calendars: [],
      timezone,
      canWrite: false,
    };
  }

  const allEvents: CalendarEvent[] = [];
  const allCalendars: string[] = [];
  let canWrite = false;

  for (const provider of providers) {
    try {
      const calendars = await provider.listCalendars();
      allCalendars.push(...calendars.map((c) => c.name));

      const events = await provider.getEvents(startDate, endDate);
      allEvents.push(...events);

      if (provider.canWrite) canWrite = true;
    } catch (e) {
      console.log(`Provider ${provider.type} failed:`, e);
    }
  }

  // Deduplicate by id, sort by start time
  const seen = new Set<string>();
  const dedupedEvents = allEvents.filter((ev) => {
    if (seen.has(ev.id)) return false;
    seen.add(ev.id);
    return true;
  });
  dedupedEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Cap at ~50 events (next 7 days detailed, summarize further out)
  const capped = dedupedEvents.slice(0, 50);

  return {
    connected: true,
    events: capped,
    calendars: Array.from(new Set(allCalendars)),
    timezone,
    canWrite,
  };
}

export async function getGoogleCalendarClient(userId: string) {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
  });

  if (!account?.refresh_token) {
    throw new Error("No Google account connected");
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });

  // Refresh token if needed
  const { credentials } = await oauth2Client.refreshAccessToken();
  oauth2Client.setCredentials(credentials);

  // Update stored tokens
  if (credentials.access_token) {
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: credentials.access_token,
        expires_at: credentials.expiry_date
          ? Math.floor(credentials.expiry_date / 1000)
          : null,
      },
    });
  }

  return google.calendar({ version: "v3", auth: oauth2Client });
}

/**
 * Get the hour and day-of-week for a Date in a specific IANA timezone.
 * Uses Intl so it works correctly on UTC servers (Vercel).
 */
function getLocalParts(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    minute: "numeric",
    weekday: "short",
    timeZone: tz,
  }).formatToParts(date);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const dayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const isWeekend = dayName === "Sat" || dayName === "Sun";
  return { hour, minute, isWeekend };
}

/** @deprecated Use getCalendarContext() instead — AI reasons over raw events */
export async function getAvailableSlots(
  userId: string,
  startDate: Date,
  endDate: Date,
  timezone = "America/Los_Angeles"
): Promise<
  Array<{ start: Date; end: Date; duration: number }>
> {
  const calendar = await getGoogleCalendarClient(userId);

  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      items: [{ id: "primary" }],
    },
  });

  const busySlots =
    data.calendars?.primary?.busy?.map((b) => ({
      start: new Date(b.start!),
      end: new Date(b.end!),
    })) ?? [];

  // Generate available 30-minute slots during business hours (9 AM - 6 PM)
  const slots: Array<{ start: Date; end: Date; duration: number }> = [];
  const current = new Date(startDate);

  // Snap to next :00 or :30 boundary so slots start on even times
  const { minute: mins } = getLocalParts(current, timezone);
  if (mins > 0 && mins < 30) {
    current.setMinutes(current.getMinutes() + (30 - mins), 0, 0);
  } else if (mins > 30) {
    current.setMinutes(current.getMinutes() + (60 - mins), 0, 0);
  } else {
    current.setSeconds(0, 0);
  }

  while (current < endDate) {
    const { hour, isWeekend } = getLocalParts(current, timezone);

    // Skip weekends and outside business hours (in host's timezone)
    if (isWeekend || hour < 9 || hour >= 18) {
      current.setMinutes(current.getMinutes() + 30);
      continue;
    }

    const slotEnd = new Date(current.getTime() + 30 * 60 * 1000);

    // Check if slot overlaps with any busy period
    const isBusy = busySlots.some(
      (busy) => current < busy.end && slotEnd > busy.start
    );

    if (!isBusy) {
      slots.push({
        start: new Date(current),
        end: slotEnd,
        duration: 30,
      });
    }

    current.setMinutes(current.getMinutes() + 30);
  }

  return slots;
}

export async function createCalendarEvent(
  userId: string,
  params: {
    summary: string;
    description?: string;
    startTime: Date;
    endTime: Date;
    attendeeEmails: string[];
    addMeetLink?: boolean;
  }
) {
  const calendar = await getGoogleCalendarClient(userId);

  const event = {
    summary: params.summary,
    description: params.description,
    start: { dateTime: params.startTime.toISOString() },
    end: { dateTime: params.endTime.toISOString() },
    attendees: params.attendeeEmails.map((email) => ({ email })),
    ...(params.addMeetLink && {
      conferenceData: {
        createRequest: {
          requestId: `agentenvoy-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
  };

  const { data } = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
    conferenceDataVersion: params.addMeetLink ? 1 : 0,
    sendUpdates: "all",
  });

  return {
    eventId: data.id,
    htmlLink: data.htmlLink,
    meetLink: data.conferenceData?.entryPoints?.find(
      (e) => e.entryPointType === "video"
    )?.uri,
  };
}
