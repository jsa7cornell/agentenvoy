/**
 * GET /api/dashboard/insight — "Today's Insight" card under the dashboard calendar widget.
 *
 * One short, playful, calendar-grounded sentence. Regenerated once per day
 * per user (host's local date). Cached in `preferences.explicit.dailyInsight`
 * so we don't trigger a Google sync on every dashboard load.
 *
 * Returns `{ content: null }` when the calendar is empty or disconnected —
 * the UI hides the card in that case.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getUserTimezone } from "@/lib/timezone";
import { generateDailyInsight } from "@/lib/calendar-read";

interface DailyInsightCache {
  date: string; // YYYY-MM-DD in host tz
  content: string;
}

interface ExplicitPrefs {
  dailyInsight?: DailyInsightCache;
  [key: string]: unknown;
}
interface UserPreferences {
  explicit?: ExplicitPrefs;
  [key: string]: unknown;
}

function todayKey(tz: string): string {
  // YYYY-MM-DD in the host's timezone — the cache rollover key.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, preferences: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const prefs = (user.preferences as UserPreferences) || {};
  const explicit: ExplicitPrefs = prefs.explicit || {};
  const tz = getUserTimezone(prefs as unknown as Record<string, unknown>);
  const today = todayKey(tz);

  // `?refresh=1` bypasses the cache — used by the "another one" link in the
  // Today's Insight card so a curious user can roll the dice again.
  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";

  // Cache hit: same day, return cached content without touching the calendar.
  const cached = explicit.dailyInsight;
  if (!forceRefresh && cached && cached.date === today && cached.content) {
    return NextResponse.json({ content: cached.content, date: today, cached: true });
  }

  // Cache miss: generate, save, return. On empty calendar the generator
  // returns null; we still write the date so we don't hammer the LLM on
  // every refresh during an empty-calendar day.
  const content = await generateDailyInsight(user.id, tz);

  const nextInsight: DailyInsightCache | undefined = content
    ? { date: today, content }
    : undefined;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      preferences: {
        ...prefs,
        explicit: {
          ...explicit,
          // Always stamp the date to avoid repeat LLM calls on empty days.
          dailyInsight: nextInsight ?? { date: today, content: "" },
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({ content: content ?? null, date: today, cached: false });
}
