import { google, calendar_v3 } from "googleapis";
import { Prisma } from "@prisma/client";
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
  iCalUID?: string; // consistent across calendars — used for cross-calendar dedup
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
  eventType?: string; // "default", "workingLocation", "outOfOffice", etc.
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

    const results = await Promise.all(
      calendars.map(async (cal) => {
        try {
          const { data } = await this.client.events.list({
            calendarId: cal.id,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 100,
          });

          return (data.items ?? []).map((ev) => {
            const isAllDay = !ev.start?.dateTime;
            const evStart = isAllDay
              ? new Date(ev.start?.date + "T00:00:00")
              : new Date(ev.start!.dateTime!);
            const evEnd = isAllDay
              ? new Date(ev.end?.date + "T00:00:00")
              : new Date(ev.end!.dateTime!);

            const hostAttendee = ev.attendees?.find(
              (a) => a.email === this.hostEmail || a.self
            );

            return {
              id: ev.id || crypto.randomUUID(),
              iCalUID: ev.iCalUID || undefined,
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
            } as CalendarEvent;
          });
        } catch (e) {
          console.log(`Failed to fetch events for calendar ${cal.name}:`, e);
          return [] as CalendarEvent[];
        }
      })
    );

    return results.flat();
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
  timezone = "America/Los_Angeles",
  activeCalendarIds?: string[]
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
      const filteredCalendars =
        activeCalendarIds && activeCalendarIds.length > 0
          ? calendars.filter((c) => activeCalendarIds.includes(c.id))
          : calendars;
      allCalendars.push(...filteredCalendars.map((c) => c.name));

      const events = await provider.getEvents(startDate, endDate);
      const filteredEvents =
        activeCalendarIds && activeCalendarIds.length > 0
          ? events.filter((ev) => filteredCalendars.some((c) => c.name === ev.calendar))
          : events;
      allEvents.push(...filteredEvents);

      if (provider.canWrite) canWrite = true;
    } catch (e) {
      console.log(`Provider ${provider.type} failed:`, e);
    }
  }

  // Deduplicate by iCalUID (cross-calendar) then by id (same calendar), sort by start time
  const seen = new Set<string>();
  const dedupedEvents = allEvents.filter((ev) => {
    const dedupKey = ev.iCalUID || ev.id;
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    // Also track by id to prevent same-calendar dupes
    if (ev.iCalUID) seen.add(ev.id);
    return true;
  });
  dedupedEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Prioritize relevant events: filter declined and transparent to the end
  // so the cap doesn't silently drop important later-week events
  const relevant = dedupedEvents.filter(
    (ev) => ev.responseStatus !== "declined" && !ev.isTransparent
  );
  const context = dedupedEvents.filter(
    (ev) => ev.responseStatus === "declined" || ev.isTransparent
  );
  // Cap sized for an 8-week horizon (~50/week busy ceiling + buffer).
  // The LLM context builder re-caps as needed downstream.
  const capped = [...relevant.slice(0, 400), ...context.slice(0, 100)]
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  return {
    connected: true,
    events: capped,
    calendars: Array.from(new Set(allCalendars)),
    timezone,
    canWrite,
  };
}

/**
 * Detect whether an error thrown from the Google client chain is a
 * "token is dead, user needs to reconnect" situation rather than a
 * transient API failure. Covers:
 *   - our own "No Google account connected" throw from getGoogleCalendarClient
 *   - `invalid_grant` from refreshAccessToken (revoked, password changed, expired)
 *   - explicit 401/403 responses from googleapis (GaxiosError shape)
 */
export function isDeadGoogleAuthError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("No Google account connected")) return true;
  if (message.includes("invalid_grant")) return true;
  if (/token.*(expired|revoked)/i.test(message)) return true;
  const code = (err as { code?: number | string }).code;
  if (code === 401 || code === 403 || code === "401" || code === "403") return true;
  return false;
}

/**
 * Clear a user's Google refresh token so subsequent `/api/connections/status`
 * reads correctly report `connected: false`. Use this when the token is
 * confirmed dead — the user will be prompted to sign in again. Idempotent.
 */
export async function clearGoogleRefreshToken(userId: string): Promise<void> {
  await prisma.account.updateMany({
    where: { userId, provider: "google" },
    data: {
      refresh_token: null,
      access_token: null,
      expires_at: null,
    },
  });
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

  // Refresh token only if expired or expiring within 60 seconds
  const tokenValid = account.expires_at && account.expires_at * 1000 > Date.now() + 60_000;
  if (!tokenValid) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);

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

// --- Calendar Sync Infrastructure ---

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Serializable version of CalendarEvent for JSON storage in CalendarCache.
 */
interface StoredCalendarEvent {
  id: string;
  iCalUID?: string;
  summary: string;
  start: string; // ISO string
  end: string;
  calendar: string;
  provider: string;
  location?: string;
  attendeeCount?: number;
  responseStatus?: string;
  isAllDay: boolean;
  isRecurring: boolean;
  isTransparent?: boolean;
  eventType?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function toStored(ev: CalendarEvent): StoredCalendarEvent {
  return {
    ...ev,
    start: ev.start.toISOString(),
    end: ev.end.toISOString(),
  };
}

function fromStored(ev: StoredCalendarEvent): CalendarEvent {
  return {
    ...ev,
    start: new Date(ev.start),
    end: new Date(ev.end),
  };
}

/**
 * Sync a user's calendars using Google's incremental sync (syncToken).
 * On first call or 410 GONE, performs a full sync.
 * Returns true if events changed (schedule should be recomputed).
 */
export async function syncCalendar(userId: string, activeCalendarIds?: string[]): Promise<{ changed: boolean; events: CalendarEvent[] }> {
  const client = await getGoogleCalendarClient(userId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const hostEmail = user?.email || "";

  // Get all calendars, then filter to active set if configured
  const { data: calList } = await client.calendarList.list();
  const allCalendars = (calList.items ?? []).map((c) => ({
    id: c.id || "primary",
    name: c.summary || c.id || "primary",
  }));
  const calendars =
    activeCalendarIds && activeCalendarIds.length > 0
      ? allCalendars.filter((c) => activeCalendarIds.includes(c.id))
      : allCalendars;

  let anyChanged = false;

  // Sync each calendar in parallel
  await Promise.all(
    calendars.map(async (cal) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cached = await (prisma as any).calendarCache.findUnique({
          where: { userId_calendarId: { userId, calendarId: cal.id } },
        });

        // Check if cache is fresh enough (skip sync)
        if (cached && cached.lastSyncedAt.getTime() > Date.now() - CACHE_TTL_MS) {
          return; // Still fresh
        }

        let events: StoredCalendarEvent[];
        let newSyncToken: string | undefined;

        if (cached?.syncToken) {
          // Incremental sync
          try {
            const result = await incrementalSync(client, cal, cached.syncToken, cached.events as unknown as StoredCalendarEvent[], hostEmail);
            events = result.events;
            newSyncToken = result.syncToken;
            if (result.changed) anyChanged = true;
          } catch (e: unknown) {
            // 410 GONE — syncToken expired, do full sync
            if (e && typeof e === "object" && "code" in e && (e as { code: number }).code === 410) {
              const result = await fullSync(client, cal, hostEmail);
              events = result.events;
              newSyncToken = result.syncToken;
              anyChanged = true;
            } else {
              throw e;
            }
          }
        } else {
          // First sync — full fetch
          const result = await fullSync(client, cal, hostEmail);
          events = result.events;
          newSyncToken = result.syncToken;
          anyChanged = true;
        }

        // Upsert cache
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).calendarCache.upsert({
          where: { userId_calendarId: { userId, calendarId: cal.id } },
          create: {
            userId,
            calendarId: cal.id,
            calendarName: cal.name,
            syncToken: newSyncToken || null,
            events: events as unknown as Prisma.InputJsonValue,
            lastSyncedAt: new Date(),
          },
          update: {
            calendarName: cal.name,
            syncToken: newSyncToken || null,
            events: events as unknown as Prisma.InputJsonValue,
            lastSyncedAt: new Date(),
          },
        });
      } catch (e) {
        console.log(`[syncCalendar] Failed to sync calendar ${cal.name}:`, e);
      }
    })
  );

  // Collect all events from cache — honor the activeCalendarIds filter so
  // stale cached entries from deselected calendars don't bleed into results.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allCaches = await (prisma as any).calendarCache.findMany({
    where: {
      userId,
      ...(activeCalendarIds && activeCalendarIds.length > 0
        ? { calendarId: { in: activeCalendarIds } }
        : {}),
    },
    select: { events: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allEvents = (allCaches as any[]).flatMap((c: { events: unknown }) =>
    (c.events as unknown as StoredCalendarEvent[]).map(fromStored)
  );

  return { changed: anyChanged, events: allEvents };
}

/**
 * Full sync: fetch all events in 8-week window, get initial syncToken.
 */
async function fullSync(
  client: ReturnType<typeof google.calendar>,
  cal: { id: string; name: string },
  hostEmail: string
): Promise<{ events: StoredCalendarEvent[]; syncToken?: string }> {
  const now = new Date();
  // Start 7 days in the past so the current week (which may be partially in the past)
  // still gets fully populated. Google returns events whose end > timeMin.
  const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const horizon = new Date(now.getTime() + 56 * 24 * 60 * 60 * 1000); // 8 weeks forward
  const events: StoredCalendarEvent[] = [];
  let pageToken: string | undefined;
  let syncToken: string | undefined;
  let pageCount = 0;
  let rawItemCount = 0;

  do {
    pageCount++;
    const { data } = await client.events.list({
      calendarId: cal.id,
      timeMin: timeMin.toISOString(),
      timeMax: horizon.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    rawItemCount += (data.items ?? []).length;

    for (const ev of data.items ?? []) {
      const isAllDay = !ev.start?.dateTime;
      const hostAttendee = ev.attendees?.find((a) => a.email === hostEmail || a.self);
      const evType = (ev as Record<string, unknown>).eventType as string | undefined;

      // For workingLocation events, extract the label from the structured field
      let locationLabel = ev.location || undefined;
      if (evType === "workingLocation") {
        const wl = (ev as Record<string, unknown>).workingLocation as Record<string, unknown> | undefined;
        locationLabel =
          (wl?.customLocation as Record<string, unknown> | undefined)?.label as string ||
          (wl?.officeLocation as Record<string, unknown> | undefined)?.label as string ||
          (wl?.homeOffice !== undefined ? "Home" : undefined) ||
          ev.summary ||
          "Working remotely";
      }

      events.push({
        id: ev.id || crypto.randomUUID(),
        iCalUID: ev.iCalUID || undefined,
        summary: ev.summary || "(no title)",
        start: isAllDay
          ? new Date(ev.start?.date + "T00:00:00").toISOString()
          : new Date(ev.start!.dateTime!).toISOString(),
        end: isAllDay
          ? new Date(ev.end?.date + "T00:00:00").toISOString()
          : new Date(ev.end!.dateTime!).toISOString(),
        calendar: cal.name,
        provider: "google",
        location: locationLabel,
        attendeeCount: ev.attendees?.length ?? 0,
        responseStatus: hostAttendee?.responseStatus || undefined,
        isAllDay,
        isRecurring: !!ev.recurringEventId,
        isTransparent: ev.transparency === "transparent",
        eventType: evType,
      });
    }

    pageToken = data.nextPageToken || undefined;
    if (!pageToken) syncToken = data.nextSyncToken || undefined;
  } while (pageToken);

  console.log(
    `[fullSync] cal="${cal.name}" id=${cal.id} pages=${pageCount} rawItems=${rawItemCount} stored=${events.length} timeMin=${timeMin.toISOString()} timeMax=${horizon.toISOString()}`
  );

  return { events, syncToken };
}

/**
 * Incremental sync: fetch only changed events since last syncToken.
 * Merges changes into existing event list.
 */
async function incrementalSync(
  client: ReturnType<typeof google.calendar>,
  cal: { id: string; name: string },
  syncToken: string,
  existingEvents: StoredCalendarEvent[],
  hostEmail: string
): Promise<{ events: StoredCalendarEvent[]; syncToken?: string; changed: boolean }> {
  const changedIds = new Set<string>();
  const newEvents: StoredCalendarEvent[] = [];
  const deletedIds = new Set<string>();
  let pageToken: string | undefined;
  let newSyncToken: string | undefined;

  do {
    const { data } = await client.events.list({
      calendarId: cal.id,
      syncToken,
      pageToken,
    });

    for (const ev of data.items ?? []) {
      if (ev.status === "cancelled") {
        deletedIds.add(ev.id!);
        changedIds.add(ev.id!);
      } else {
        const isAllDay = !ev.start?.dateTime;
        const hostAttendee = ev.attendees?.find((a) => a.email === hostEmail || a.self);
        const evType = (ev as Record<string, unknown>).eventType as string | undefined;

        let locationLabel = ev.location || undefined;
        if (evType === "workingLocation") {
          const wl = (ev as Record<string, unknown>).workingLocation as Record<string, unknown> | undefined;
          locationLabel =
            (wl?.customLocation as Record<string, unknown> | undefined)?.label as string ||
            (wl?.officeLocation as Record<string, unknown> | undefined)?.label as string ||
            (wl?.homeOffice !== undefined ? "Home" : undefined) ||
            ev.summary ||
            "Working remotely";
        }

        newEvents.push({
          id: ev.id || crypto.randomUUID(),
          iCalUID: ev.iCalUID || undefined,
          summary: ev.summary || "(no title)",
          start: isAllDay
            ? new Date(ev.start?.date + "T00:00:00").toISOString()
            : new Date(ev.start!.dateTime!).toISOString(),
          end: isAllDay
            ? new Date(ev.end?.date + "T00:00:00").toISOString()
            : new Date(ev.end!.dateTime!).toISOString(),
          calendar: cal.name,
          provider: "google",
          location: locationLabel,
          attendeeCount: ev.attendees?.length ?? 0,
          responseStatus: hostAttendee?.responseStatus || undefined,
          isAllDay,
          isRecurring: !!ev.recurringEventId,
          isTransparent: ev.transparency === "transparent",
          eventType: evType,
        });
        changedIds.add(ev.id!);
      }
    }

    pageToken = data.nextPageToken || undefined;
    if (!pageToken) newSyncToken = data.nextSyncToken || undefined;
  } while (pageToken);

  const changed = changedIds.size > 0;

  // Merge: remove deleted/updated events, add new versions
  const merged = existingEvents
    .filter((ev) => !changedIds.has(ev.id))
    .concat(newEvents);

  return { events: merged, syncToken: newSyncToken, changed };
}

/**
 * Get cached calendar events for a user. If cache is stale, performs incremental sync.
 * Returns the same CalendarContext shape as getCalendarContext for backward compat.
 */
export async function getCachedCalendarContext(
  userId: string,
  timezone = "America/Los_Angeles"
): Promise<CalendarContext> {
  try {
    // Read activeCalendarIds from user preferences
    const userPrefs = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    const prefs = (userPrefs?.preferences as import("./scoring").UserPreferences) || {};
    const activeCalendarIds = prefs.explicit?.activeCalendarIds;

    const { events } = await syncCalendar(userId, activeCalendarIds);

    if (events.length === 0) {
      // Check if calendar is even connected
      const account = await prisma.account.findFirst({
        where: { userId, provider: "google" },
        select: { id: true },
      });
      if (!account) {
        return { connected: false, events: [], calendars: [], timezone, canWrite: false };
      }
    }

    // Deduplicate by iCalUID (cross-calendar) then by id (same calendar)
    const seen = new Set<string>();
    const droppedSamples: string[] = [];
    const deduped = events.filter((ev) => {
      const dedupKey = ev.iCalUID || ev.id;
      if (seen.has(dedupKey)) {
        if (droppedSamples.length < 5) {
          droppedSamples.push(`${ev.summary} [${ev.calendar}] key=${dedupKey.slice(0, 20)}`);
        }
        return false;
      }
      seen.add(dedupKey);
      if (ev.iCalUID) seen.add(ev.id);
      return true;
    });
    console.log(
      `[getCachedCalendarContext] events=${events.length} deduped=${deduped.length} dropped=${events.length - deduped.length}` +
        (droppedSamples.length > 0 ? ` samples=${JSON.stringify(droppedSamples)}` : "")
    );
    deduped.sort((a, b) => a.start.getTime() - b.start.getTime());

    const relevant = deduped.filter(
      (ev) => ev.responseStatus !== "declined" && !ev.isTransparent
    );
    const context = deduped.filter(
      (ev) => ev.responseStatus === "declined" || ev.isTransparent
    );
    // Cap sized for an 8-week horizon (~50/week busy ceiling + buffer).
    // The LLM context builder re-caps as needed downstream.
    const capped = [...relevant.slice(0, 400), ...context.slice(0, 100)]
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    const calendarNames = Array.from(new Set(events.map((e) => e.calendar)));

    // Detect active working location from Google Calendar's workingLocation events
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const activeWorkingLocation = deduped.find(
      (ev) =>
        ev.eventType === "workingLocation" &&
        ev.start <= todayEnd &&
        ev.end > todayStart &&
        ev.location
    );
    const hostLocation = activeWorkingLocation?.location;

    return {
      connected: true,
      events: capped,
      calendars: calendarNames,
      timezone,
      canWrite: true, // Google provider is always writable
      hostLocation,
    };
  } catch (e) {
    console.log("[getCachedCalendarContext] Falling back to live fetch:", e);
    // Fallback to live fetch if sync fails
    const now = new Date();
    const horizon = new Date(now.getTime() + 56 * 24 * 60 * 60 * 1000); // 8 weeks
    return getCalendarContext(userId, now, horizon, timezone);
  }
}

// --- Computed Schedule ---

import { computeSchedule, computeInputHash, type ScoredSlot, type UserPreferences } from "./scoring";
import { safeTimezone } from "./timezone";

/**
 * Get the computed schedule for a user, recomputing only if inputs changed.
 * This is the main entry point for both the slots endpoint and LLM prompts.
 */
export async function getOrComputeSchedule(userId: string, options?: { forceRefresh?: boolean }): Promise<{
  slots: ScoredSlot[];
  events: CalendarEvent[];
  timezone: string;
  connected: boolean;
  canWrite: boolean;
  calendars: string[];
  hostLocation?: string;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      preferences: true,
      persistentKnowledge: true,
      upcomingSchedulePreferences: true,
    },
  });
  // computedSchedule is a separate model pending prisma client regen
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const computedRecord = await (prisma as any).computedSchedule.findUnique({ where: { userId } });

  if (!user) throw new Error("User not found");

  const prefs = (user.preferences as UserPreferences) || {};
  const tz = safeTimezone(prefs.explicit?.timezone);

  // Location expiry is handled by the availability rule lifecycle
  // (expireRules() runs on GET /api/tuner/preferences) — no cleanup needed here.

  // Force-clear calendar cache if requested (e.g., host said "check again")
  if (options?.forceRefresh) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).calendarCache.deleteMany({ where: { userId } });
    await invalidateSchedule(userId);
  }

  // Get cached calendar events (syncs if stale)
  const calCtx = await getCachedCalendarContext(userId, tz);

  if (!calCtx.connected) {
    return {
      slots: [],
      events: [],
      timezone: tz,
      connected: false,
      canWrite: false,
      calendars: [],
    };
  }

  // Check if recomputation is needed (includes internal calendar fields)
  const inputHash = computeInputHash(calCtx.events, prefs, user.persistentKnowledge, user.upcomingSchedulePreferences);
  const existing = computedRecord as { inputHash?: string; slots?: ScoredSlot[] } | null;

  if (existing?.inputHash === inputHash && existing.slots) {
    // Schedule is current — return cached
    return {
      slots: existing.slots,
      events: calCtx.events,
      timezone: tz,
      connected: true,
      canWrite: calCtx.canWrite,
      calendars: calCtx.calendars,
      hostLocation: calCtx.hostLocation,
    };
  }

  // Recompute
  const slots = computeSchedule(calCtx.events, prefs, user.persistentKnowledge, user.upcomingSchedulePreferences);

  // Store computed schedule
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).computedSchedule.upsert({
    where: { userId },
    create: {
      userId,
      slots: slots as unknown as Prisma.InputJsonValue,
      computedAt: new Date(),
      inputHash,
    },
    update: {
      slots: slots as unknown as Prisma.InputJsonValue,
      computedAt: new Date(),
      inputHash,
    },
  });

  return {
    slots,
    events: calCtx.events,
    timezone: tz,
    connected: true,
    canWrite: calCtx.canWrite,
    calendars: calCtx.calendars,
    hostLocation: calCtx.hostLocation,
  };
}

/**
 * Force recomputation of the schedule. Call after preference/knowledge changes.
 */
export async function invalidateSchedule(userId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).computedSchedule.deleteMany({ where: { userId } });
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
