/**
 * POST /api/webhooks/google-calendar
 *
 * Receives Google Calendar push notifications from registered events.watch
 * and calendarList.watch channels. Google POSTs here when a watched resource
 * changes (or on the initial "sync" handshake right after registration).
 *
 * Security: every channel gets a per-channel 32-byte random token stored in
 * CalendarWatchChannel.token. Google echoes it in X-Goog-Channel-Token on
 * every ping. We reject pings with unknown channelId, inactive channels, or
 * mismatched tokens.
 *
 * Response deadline: Google expects a response within ~5s. We return 200
 * immediately and defer all real work (incrementalSyncForUser, invalidation)
 * via Vercel waitUntil — same pattern as confirm-pipeline.ts:977.
 *
 * Disabled: when GOOGLE_WATCH_DISABLED=1 (default in dev/preview), returns
 * 200 no-op. Channels are never registered in that env so pings never arrive,
 * but defense-in-depth means we no-op cleanly if they do.
 *
 * See proposal 2026-05-04_google-calendar-push-notifications §3c for the
 * dead-token cleanup ordering rationale.
 */

import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { prisma } from "@/lib/prisma";
import {
  incrementalSyncForUser,
  invalidateSchedule,
  invalidateCalendarListCache,
  isDeadGoogleAuthError,
  clearGoogleRefreshToken,
} from "@/lib/calendar";
import { stopAllWatchesForUser } from "@/lib/google-watch";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (process.env.GOOGLE_WATCH_DISABLED === "1") {
    return new Response(null, { status: 200 });
  }

  const channelId = req.headers.get("x-goog-channel-id");
  const token = req.headers.get("x-goog-channel-token");
  const resState = req.headers.get("x-goog-resource-state");

  if (!channelId || !token) {
    return new Response(null, { status: 400 });
  }

  const channel = await prisma.calendarWatchChannel.findUnique({
    where: { channelId },
  });

  if (!channel || !channel.active || channel.token !== token) {
    // Unknown, stale, or forged ping — reject silently to not leak info
    return new Response(null, { status: 404 });
  }

  // Initial handshake after watch registration — record ping, no sync needed
  if (resState === "sync") {
    await prisma.calendarWatchChannel.update({
      where: { channelId },
      data: { lastPingAt: new Date() },
    });
    return new Response(null, { status: 200 });
  }

  // ACK immediately; real work deferred via waitUntil (Google's ~5s deadline)
  waitUntil(
    (async () => {
      try {
        let foundChanges = false;

        if (channel.kind === "events" && channel.calendarId) {
          foundChanges = await incrementalSyncForUser(channel.userId, channel.calendarId);
          await invalidateSchedule(channel.userId);
        } else if (channel.kind === "calendarList") {
          await invalidateCalendarListCache(channel.userId);
          foundChanges = true; // any list change counts
        }

        await prisma.calendarWatchChannel.update({
          where: { channelId },
          data: {
            lastPingAt: new Date(),
            ...(foundChanges ? { lastSyncDiffAt: new Date() } : {}),
          },
        });
      } catch (err) {
        // Dead-token cleanup. ORDER MATTERS (proposal §3c round-2 m1):
        // clearGoogleRefreshToken is DB-only and can't fail with a token error,
        // so we run it first to record the dead-OAuth state even if every
        // subsequent channels.stop also throws. stopAllWatchesForUser
        // per-channel try/catches per its §3b contract.
        if (isDeadGoogleAuthError(err)) {
          await clearGoogleRefreshToken(channel.userId);
          await stopAllWatchesForUser(channel.userId);
        }
        console.error("[google-watch] handler error", { channelId, err });
      }
    })(),
  );

  return new Response(null, { status: 200 });
}
