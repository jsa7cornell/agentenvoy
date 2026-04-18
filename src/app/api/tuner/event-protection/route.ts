import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { invalidateSchedule } from "@/lib/calendar";
import { type EventProtectionOverride } from "@/lib/scoring";

/**
 * PUT /api/tuner/event-protection
 * Body: {
 *   eventId: string;           // when scope === "series", this is the master id
 *   score: 0 | 3 | 5 | null;
 *   scope?: "instance" | "series";   // default "instance"
 * }
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

  let body: { eventId?: string; score?: 0 | 3 | 5 | null; scope?: "instance" | "series" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { eventId, score } = body;
  const scope: "instance" | "series" = body.scope === "series" ? "series" : "instance";
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

  // Overrides are keyed by (eventId, scope) — an instance override and a
  // series override can coexist for different ids. Dedupe on that pair.
  const matchesSame = (o: EventProtectionOverride) =>
    o.eventId === eventId && (o.scope ?? "instance") === scope;
  let updated: EventProtectionOverride[];
  if (score === null || score === undefined) {
    updated = existing.filter((o) => !matchesSame(o));
  } else {
    const filtered = existing.filter((o) => !matchesSame(o));
    updated = [...filtered, { eventId, score, scope }];
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

  return NextResponse.json({ ok: true, eventId, score: score ?? null, scope });
}
