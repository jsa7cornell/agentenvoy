/**
 * UI-level preferences for the current user.
 *
 * Narrow by design — this endpoint backs the global theme sync and the
 * account page's admin-gated DevTools section. Do not fold unrelated
 * profile fields in here; the per-domain endpoints (tuner/preferences,
 * agent/knowledge) remain authoritative for their respective surfaces.
 *
 * GET  → { themeMode, timezone, isAdmin }
 * PUT  { themeMode } → { themeMode }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { UserPreferences } from "@/lib/scoring";
import { readProfileField, writeProfileField } from "@/lib/profile-fields";
import { getUserTimezone } from "@/lib/timezone";

type ThemeMode = "light" | "dark" | "auto";

function parseThemeMode(value: unknown): ThemeMode | null {
  return value === "light" || value === "dark" || value === "auto" ? value : null;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true, userClass: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const themeMode = (readProfileField(prefs, "themeMode") as ThemeMode | undefined) ?? "dark";
  const timezone = getUserTimezone(prefs as unknown as Record<string, unknown>);

  return NextResponse.json({
    themeMode,
    timezone,
    isAdmin: user.userClass === "admin",
  });
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { themeMode?: unknown } | null;
  const themeMode = parseThemeMode(body?.themeMode);
  if (!themeMode) {
    return NextResponse.json(
      { error: "Invalid themeMode (expected 'light' | 'dark' | 'auto')" },
      { status: 400 },
    );
  }

  const current = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });
  const currentPrefs = (current?.preferences as UserPreferences | null) ?? {};
  const nextPrefs = writeProfileField(currentPrefs, "themeMode", themeMode);

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      preferences: nextPrefs as unknown as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({ themeMode });
}
