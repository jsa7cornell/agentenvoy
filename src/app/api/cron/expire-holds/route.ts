import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deleteCalendarEvent } from "@/lib/calendar";

/**
 * GET /api/cron/expire-holds
 *
 * Sweeps expired tentative holds and cleans up their backing Google Calendar
 * tentative events. Runs on a daily Vercel cron schedule (see vercel.json —
 * Vercel Hobby plan caps crons at once/day, so we pick an off-peak UTC time
 * and rely on the 48h hold TTL to absorb the up-to-24h catch-up window).
 *
 * Flow per expired hold:
 *   1. Flip Hold.status from "active" to "expired"
 *   2. If Hold.calendarEventId is set, delete the tentative gcal event
 *   3. Write a system message into the negotiation session so the host
 *      has an auditable record that the hold expired unused
 *
 * Auth: Vercel Cron only. The CRON_SECRET env var gates access; Vercel
 * injects it as the Authorization Bearer on scheduled invocations.
 * Manual runs (e.g. from a dev shell) can pass `?secret=...` or set the
 * same header.
 *
 * Response shape:
 *   { swept: number, satisfied: number, errors: string[] }
 *
 * "satisfied" is always 0 from this route — that transition happens in
 * the confirm route when a meeting is booked. This sweeper only handles
 * the expiry path. It's safe to run idempotently; if a hold is already
 * past-expiry or already released, it's skipped.
 */
export async function GET(req: NextRequest) {
  // Auth gate — Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
  // Also accept ?secret= for manual dev invocation.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const fromHeader = auth?.replace(/^Bearer\s+/i, "");
    const fromQuery = new URL(req.url).searchParams.get("secret");
    if (fromHeader !== secret && fromQuery !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const now = new Date();
  const expired = await prisma.hold.findMany({
    where: {
      status: "active",
      expiresAt: { lte: now },
    },
    select: {
      id: true,
      hostId: true,
      sessionId: true,
      slotStart: true,
      calendarEventId: true,
      session: {
        select: {
          link: { select: { inviteeName: true, code: true } },
        },
      },
    },
  });

  const errors: string[] = [];
  let swept = 0;

  for (const hold of expired) {
    // Delete the backing tentative event (best-effort).
    if (hold.calendarEventId) {
      try {
        await deleteCalendarEvent(hold.hostId, hold.calendarEventId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`gcal delete ${hold.id}: ${msg}`);
      }
    }

    // Flip the Hold row to expired.
    try {
      await prisma.hold.update({
        where: { id: hold.id },
        data: { status: "expired" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`hold update ${hold.id}: ${msg}`);
      continue;
    }

    // System message into the session so the host thread has a record.
    // Non-blocking — if the message write fails we still count the sweep.
    try {
      const name = hold.session.link.inviteeName || hold.session.link.code || "the guest";
      await prisma.message.create({
        data: {
          sessionId: hold.sessionId,
          role: "system",
          content: `Tentative hold for ${name} at ${hold.slotStart.toISOString()} expired without confirmation. Slot is available again.`,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`system msg ${hold.id}: ${msg}`);
    }

    swept += 1;
  }

  return NextResponse.json({
    swept,
    satisfied: 0,
    errors,
    ranAt: now.toISOString(),
  });
}
