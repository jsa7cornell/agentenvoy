import { google } from "googleapis";
import { prisma } from "./prisma";

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
