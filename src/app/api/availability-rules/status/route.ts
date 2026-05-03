/**
 * PATCH /api/availability-rules/status
 *
 * Toggle a bookable link rule between "active" and "paused". Pausing a
 * rule causes the parent URL (/meet/<slug>/<ruleCode>) to show
 * "Meeting Unavailable" to new visitors. Existing child sessions
 * (already-created bookings) are unaffected. Reactivating restores
 * bookability immediately.
 *
 * Deliberately narrow — only writes `status`. Title, window, format
 * etc. are the edit route's responsibility.
 *
 * Body: { ruleId: string, status: "active" | "paused" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { type AvailabilityPreference } from "@/lib/availability-rules";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

const ALLOWED_STATUSES = new Set(["active", "paused"]);

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const { ruleId, status } = body;
  if (typeof ruleId !== "string" || !ruleId) {
    return NextResponse.json({ error: "ruleId is required" }, { status: 400 });
  }
  if (typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
    return NextResponse.json(
      { error: "status must be 'active' or 'paused'" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const explicit = { ...(prefs.explicit ?? {}) } as Record<string, unknown>;
  const existingRules =
    (explicit.structuredRules as AvailabilityPreference[] | undefined) ?? [];

  const targetIdx = existingRules.findIndex((r) => r.id === ruleId);
  if (targetIdx === -1) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }
  const target = existingRules[targetIdx];
  if (target.action !== "bookable") {
    return NextResponse.json(
      { error: "Rule is not a bookable link rule" },
      { status: 400 },
    );
  }

  const updatedRules = existingRules.map((r, i) =>
    i === targetIdx ? { ...r, status: status as "active" | "paused" } : r,
  );

  await prisma.user.update({
    where: { id: userId },
    data: {
      preferences: {
        ...prefs,
        explicit: {
          ...explicit,
          structuredRules: updatedRules,
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({ ok: true, ruleId, status });
}
