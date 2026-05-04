/**
 * Google Calendar push-notification channel lifecycle helpers.
 *
 * Exports:
 *   registerEventsWatch        — register a calendarId events.watch channel
 *   registerCalendarListWatch  — register a calendarList.watch channel
 *   renewWatchChannel          — stop + re-register a channel nearing expiry
 *   stopWatchChannel           — stop a single channel at Google + mark inactive
 *   stopAllWatchesForUser      — stop all active channels for a user (best-effort)
 *   reconcileEventsWatches     — diff active channels against activeCalendarIds
 *   listExpiringChannels       — channels expiring within the given window
 *
 * All functions respect GOOGLE_WATCH_DISABLED=1: when set, registration/stop
 * calls are no-ops. The webhook handler in /api/webhooks/google-calendar also
 * short-circuits when disabled. This is the default in .env.local and preview
 * environments; production explicitly sets GOOGLE_WATCH_DISABLED=0.
 *
 * See proposal 2026-05-04_google-calendar-push-notifications for the full
 * design rationale, partial-unique-index explanation, and rollout plan.
 */

import crypto from "crypto";
import { prisma } from "./prisma";
import { getGoogleCalendarClient } from "./calendar";
import type { CalendarWatchChannel } from "@prisma/client";

const WEBHOOK_URL = () =>
  `${process.env.PUBLIC_BASE_URL}/api/webhooks/google-calendar`;

function isWatchDisabled(): boolean {
  return process.env.GOOGLE_WATCH_DISABLED === "1";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register an events.watch channel for a specific calendarId.
 * Idempotent at the application layer: returns existing active channel if one
 * already exists for this (userId, calendarId). The partial unique index in
 * the migration is the DB-level safety net for concurrent races.
 */
export async function registerEventsWatch(
  userId: string,
  calendarId: string,
): Promise<CalendarWatchChannel | null> {
  if (isWatchDisabled()) return null;

  // Application-layer idempotency check
  const existing = await prisma.calendarWatchChannel.findFirst({
    where: { userId, calendarId, kind: "events", active: true },
  });
  if (existing) return existing;

  const client = await getGoogleCalendarClient(userId);
  const channelId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");

  const { data } = await client.events.watch({
    calendarId,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: WEBHOOK_URL(),
      token,
    },
  });

  if (!data.id || !data.resourceId || !data.expiration) {
    throw new Error(`[google-watch] events.watch response missing fields: ${JSON.stringify(data)}`);
  }

  return prisma.calendarWatchChannel.create({
    data: {
      channelId: data.id,
      userId,
      calendarId,
      resourceId: data.resourceId,
      token,
      kind: "events",
      expiration: new Date(Number(data.expiration)),
    },
  });
}

/**
 * Register a calendarList.watch channel for a user.
 * Idempotent: returns existing active channel if one exists.
 */
export async function registerCalendarListWatch(
  userId: string,
): Promise<CalendarWatchChannel | null> {
  if (isWatchDisabled()) return null;

  const existing = await prisma.calendarWatchChannel.findFirst({
    where: { userId, kind: "calendarList", active: true },
  });
  if (existing) return existing;

  const client = await getGoogleCalendarClient(userId);
  const channelId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (client.calendarList as any).watch({
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: WEBHOOK_URL(),
      token,
    },
  });

  if (!data.id || !data.resourceId || !data.expiration) {
    throw new Error(`[google-watch] calendarList.watch response missing fields: ${JSON.stringify(data)}`);
  }

  return prisma.calendarWatchChannel.create({
    data: {
      channelId: data.id,
      userId,
      calendarId: null,
      resourceId: data.resourceId,
      token,
      kind: "calendarList",
      expiration: new Date(Number(data.expiration)),
    },
  });
}

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

/**
 * Renew a channel nearing expiry: stop the old one + register a new one.
 * On failure, marks the old channel dead so the backstop poll takes over.
 */
export async function renewWatchChannel(channelId: string): Promise<void> {
  if (isWatchDisabled()) return;

  const channel = await prisma.calendarWatchChannel.findUnique({
    where: { channelId },
  });
  if (!channel || !channel.active) return;

  // Mark old channel inactive first — new registration is idempotent, so
  // even if this dies mid-way, the next renewal pass picks it up.
  await prisma.calendarWatchChannel.update({
    where: { channelId },
    data: { active: false },
  });

  try {
    await _stopChannelAtGoogle(channel);
  } catch {
    // Best-effort; old channel expires naturally if stop fails
  }

  if (channel.kind === "events" && channel.calendarId) {
    await registerEventsWatch(channel.userId, channel.calendarId);
  } else if (channel.kind === "calendarList") {
    await registerCalendarListWatch(channel.userId);
  }
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/**
 * Stop a single channel at Google and mark it inactive in the DB.
 * The DB row is the authoritative "we don't trust this channel" record —
 * it is marked inactive regardless of whether Google's stop succeeded.
 */
export async function stopWatchChannel(channelId: string): Promise<void> {
  const channel = await prisma.calendarWatchChannel.findUnique({
    where: { channelId },
  });
  if (!channel) return;

  await prisma.calendarWatchChannel.update({
    where: { channelId },
    data: { active: false },
  });

  try {
    await _stopChannelAtGoogle(channel);
  } catch (err) {
    console.error("[google-watch] channels.stop failed", { channelId, err });
  }
}

/**
 * Stop all active channels for a user.
 * Per-channel try/catch so one failure doesn't abort the rest.
 * The DB row is marked inactive regardless of whether Google's call succeeds.
 * This is intentional (round-2 m1 in the proposal): when a token is dead,
 * every subsequent channels.stop will also fail — aborting on the first error
 * would leave other channel rows stale.
 */
export async function stopAllWatchesForUser(userId: string): Promise<void> {
  const channels = await prisma.calendarWatchChannel.findMany({
    where: { userId, active: true },
  });

  for (const channel of channels) {
    await prisma.calendarWatchChannel.update({
      where: { channelId: channel.channelId },
      data: { active: false },
    });
    try {
      await _stopChannelAtGoogle(channel);
    } catch (err) {
      console.error("[google-watch] stopAllWatchesForUser: channels.stop failed", {
        channelId: channel.channelId,
        err,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Diff active events.watch channels against the given activeCalendarIds list.
 * Registers channels for calendars that don't have one; stops channels for
 * calendars no longer in the list.
 */
export async function reconcileEventsWatches(
  userId: string,
  activeCalendarIds: string[],
): Promise<void> {
  if (isWatchDisabled()) return;

  const existing = await prisma.calendarWatchChannel.findMany({
    where: { userId, kind: "events", active: true },
    select: { channelId: true, calendarId: true },
  });

  const existingIds = new Set(existing.map((c) => c.calendarId).filter(Boolean) as string[]);
  const targetIds = new Set(activeCalendarIds);

  // Register missing
  for (const calId of targetIds) {
    if (!existingIds.has(calId)) {
      await registerEventsWatch(userId, calId).catch((err) =>
        console.error("[google-watch] reconcile: registerEventsWatch failed", { userId, calId, err }),
      );
    }
  }

  // Stop extras
  for (const channel of existing) {
    if (channel.calendarId && !targetIds.has(channel.calendarId)) {
      await stopWatchChannel(channel.channelId).catch((err) =>
        console.error("[google-watch] reconcile: stopWatchChannel failed", { channelId: channel.channelId, err }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Return channels expiring within withinMs milliseconds.
 * Used by the daily-cron renewal phase.
 */
export async function listExpiringChannels(
  withinMs: number,
  kind?: "events" | "calendarList",
): Promise<CalendarWatchChannel[]> {
  const cutoff = new Date(Date.now() + withinMs);
  return prisma.calendarWatchChannel.findMany({
    where: {
      active: true,
      expiration: { lt: cutoff },
      ...(kind ? { kind } : {}),
    },
    orderBy: { expiration: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _stopChannelAtGoogle(
  channel: Pick<CalendarWatchChannel, "channelId" | "userId" | "resourceId">,
): Promise<void> {
  const client = await getGoogleCalendarClient(channel.userId);
  await client.channels.stop({
    requestBody: {
      id: channel.channelId,
      resourceId: channel.resourceId,
    },
  });
}
