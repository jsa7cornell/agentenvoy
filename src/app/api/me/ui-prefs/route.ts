/**
 * UI-level preferences for the current user.
 *
 * Narrow by design — this endpoint backs the global theme sync, the
 * first-night-flip explainer (progressive profile Category C), and the
 * account page's admin-gated DevTools section. Do not fold unrelated
 * profile fields in here; the per-domain endpoints (tuner/preferences,
 * agent/knowledge) remain authoritative for their respective surfaces.
 *
 * GET  → { themeMode, timezone, isAdmin, seenThemeModeExplainer }
 * PUT  { themeMode?, seenThemeModeExplainer? } → echoes accepted fields
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
  const seenThemeModeExplainer = Boolean(prefs.explicit?.seenThemeModeExplainer);

  return NextResponse.json({
    themeMode,
    timezone,
    isAdmin: user.userClass === "admin",
    seenThemeModeExplainer,
  });
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | { themeMode?: unknown; seenThemeModeExplainer?: unknown }
    | null;

  const themeMode = body?.themeMode !== undefined ? parseThemeMode(body.themeMode) : undefined;
  const seenExplainer =
    body?.seenThemeModeExplainer === true ? true : undefined;

  if (themeMode === null) {
    return NextResponse.json(
      { error: "Invalid themeMode (expected 'light' | 'dark' | 'auto')" },
      { status: 400 },
    );
  }
  if (themeMode === undefined && seenExplainer === undefined) {
    return NextResponse.json(
      { error: "No recognized fields in payload" },
      { status: 400 },
    );
  }

  const current = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });
  let nextPrefs = (current?.preferences as UserPreferences | null) ?? {};

  if (themeMode) {
    nextPrefs = writeProfileField(nextPrefs, "themeMode", themeMode);
  }
  if (seenExplainer) {
    // Direct write — seen-flags don't go through writeProfileField since
    // they're UI state, not user-facing profile fields (no legacy top-level
    // mirror to strip, not lint-gated).
    nextPrefs = {
      ...nextPrefs,
      explicit: { ...(nextPrefs.explicit ?? {}), seenThemeModeExplainer: true },
    };
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      preferences: nextPrefs as unknown as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({
    ...(themeMode ? { themeMode } : {}),
    ...(seenExplainer ? { seenThemeModeExplainer: true } : {}),
  });
}
