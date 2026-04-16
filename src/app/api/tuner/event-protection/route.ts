import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { invalidateSchedule } from "@/lib/calendar";
import { type EventProtectionOverride } from "@/lib/scoring";

/**
 * PUT /api/tuner/event-protection
 * Body: { eventId: string; score: 0 | 3 | 5 | null }
 *
 * score null  → remove override (Auto — revert to engine scoring)
 * score 0     → Open (treat as free even though event exists)
 * score 3     → Protected (harder to book, stretch-band)
 * score 5     → Blocked (hard block, never offer)
 *
 * Persists to preferences.explicit.eventProtectionOverrides and
 * invalidates the schedule cache so the next /api/tuner/schedule call
 * reflects the change.
 */
export async function PUT(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authSession.user.id;

  let body: { eventId?: string; score?: 0 | 3 | 5 | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { eventId, score } = body;
  if (!eventId || typeof eventId !== "string") {
    return NextResponse.json({ error: "Missing eventId" }, { status: 400 });
  }
  if (score !== null && score !== 0 && score !== 3 && score !== 5) {
    return NextResponse.json(
      { error: "score must be 0, 3, 5, or null" },
      { status: 400 }
    );
  }

  // Load current preferences
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const prefs = (user.preferences as Record<string, unknown>) ?? {};
  const explicit = (prefs.explicit as Record<string, unknown>) ?? {};
  const existing = (explicit.eventProtectionOverrides as EventProtectionOverride[]) ?? [];

  let updated: EventProtectionOverride[];
  if (score === null || score === undefined) {
    // Remove override (Auto)
    updated = existing.filter((o) => o.eventId !== eventId);
  } else {
    // Upsert override
    const filtered = existing.filter((o) => o.eventId !== eventId);
    updated = [...filtered, { eventId, score }];
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      preferences: {
        ...prefs,
        explicit: {
          ...explicit,
          eventProtectionOverrides: updated,
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Invalidate schedule cache so next fetch recomputes with new override
  await invalidateSchedule(userId);

  return NextResponse.json({ ok: true, eventId, score: score ?? null });
}
