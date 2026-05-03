import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { buildKnowledgePreview } from "@/agent/agent-runner";
import { invalidateSchedule, invalidateCalendarListCache } from "@/lib/calendar";
import { compilePreferenceRules } from "@/lib/scoring";
import type { UserPreferences } from "@/lib/scoring";
import { getUserTimezone } from "@/lib/timezone";
import { readProfileField } from "@/lib/profile-fields";
import { google } from "googleapis";

/**
 * Lazy-migrate `activeCalendarIds` from the literal alias `["primary"]`
 * (seed default for users created pre-2026-04-29) to the actual enumerated
 * primary-calendar id (typically the user's email). The literal alias
 * works for Google's API server-side resolution but doesn't match the
 * email-keyed entries the manage-calendars dropdown enumerates, so the UI
 * shows zero matches and no calendar reads as primary.
 *
 * Best-effort: returns the input array on any failure (no Google account,
 * calendarList call fails, no `primary: true` flag in the response). The
 * literal "primary" alias still works for scoring; only the UI badge is
 * affected. Async failure does NOT block the GET response.
 *
 * Side-effect: writes back the resolved id so subsequent reads (and the
 * dropdown that reads activeCalendarIds directly) see the canonical id.
 * Idempotent — running again on already-resolved ids is a no-op.
 */
async function resolvePrimaryCalendarIfNeeded(
  userId: string,
  activeCalendarIds: string[],
  prefs: UserPreferences,
): Promise<string[]> {
  // Only the literal-["primary"] case needs migration. Empty array or
  // any already-enumerated id is left alone.
  const needsResolution =
    activeCalendarIds.length === 1 && activeCalendarIds[0] === "primary";
  if (!needsResolution) return activeCalendarIds;

  try {
    const account = await prisma.account.findFirst({
      where: { userId, provider: "google" },
      select: { access_token: true, refresh_token: true },
    });
    if (!account?.access_token) return activeCalendarIds;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth2Client.setCredentials({
      access_token: account.access_token,
      refresh_token: account.refresh_token,
    });
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const calList = await calendar.calendarList.list();
    const primary = (calList.data.items ?? []).find((c) => c.primary);
    if (!primary?.id || primary.id === "primary") return activeCalendarIds;

    const resolved = [primary.id];
    const explicit =
      (prefs.explicit as Record<string, unknown> | undefined) ?? {};
    await prisma.user.update({
      where: { id: userId },
      data: {
        preferences: {
          ...prefs,
          explicit: { ...explicit, activeCalendarIds: resolved },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    // Invalidate the CalendarListCache so the next syncCalendar call gets a
    // fresh list reflecting the newly-resolved id rather than the stale literal.
    // (Wedge A — proposal 2026-05-02_picker-load-perf §3c)
    await invalidateCalendarListCache(userId);
    return resolved;
  } catch (e) {
    console.warn(
      "[knowledge] activeCalendarIds lazy-migration failed (keeping literal):",
      e,
    );
    return activeCalendarIds;
  }
}

// GET /api/agent/knowledge
// Returns the host's knowledge base + a rendered preview
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      persistentKnowledge: true,
      upcomingSchedulePreferences: true,
      preferences: true,
      hostDirectives: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const preview = buildKnowledgePreview({
    preferences: (user.preferences as Record<string, unknown>) || {},
    directives: (user.hostDirectives as string[]) || [],
    persistentKnowledge: user.persistentKnowledge,
    upcomingSchedulePreferences: user.upcomingSchedulePreferences,
  });

  const compiled = ((user.preferences as Record<string, unknown>)?.compiled ?? null) as { ambiguities?: string[] } | null;
  const prefs = (user.preferences as UserPreferences) || {};

  const rawActiveCalendarIds = prefs.explicit?.activeCalendarIds ?? [];
  const activeCalendarIds = await resolvePrimaryCalendarIfNeeded(
    session.user.id,
    rawActiveCalendarIds,
    prefs,
  );

  return NextResponse.json({
    persistentKnowledge: user.persistentKnowledge || "",
    upcomingSchedulePreferences: user.upcomingSchedulePreferences || "",
    preview,
    ambiguities: compiled?.ambiguities ?? [],
    activeCalendarIds,
    phone: readProfileField(prefs, "phone") || "",
    videoProvider: readProfileField(prefs, "videoProvider") || "google-meet",
    zoomLink: readProfileField(prefs, "zoomLink") || "",
    defaultDuration: readProfileField(prefs, "defaultDuration") || 30,
  });
}

// PUT /api/agent/knowledge
// Update the host's knowledge base
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { persistentKnowledge, upcomingSchedulePreferences, phone, videoProvider, zoomLink, defaultDuration } = body;

  // If meeting settings are being updated, save them to preferences first
  const hasMeetingSettings = phone !== undefined || videoProvider !== undefined || zoomLink !== undefined || defaultDuration !== undefined;
  if (hasMeetingSettings) {
    const currentUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { preferences: true },
    });
    const currentPrefs = (currentUser?.preferences as Record<string, unknown>) || {};
    const updates: Record<string, unknown> = {};
    if (phone !== undefined) updates.phone = phone || null;
    if (videoProvider !== undefined) updates.videoProvider = videoProvider || "google-meet";
    if (zoomLink !== undefined) updates.zoomLink = zoomLink || null;
    if (defaultDuration !== undefined) updates.defaultDuration = defaultDuration || 30;
    await prisma.user.update({
      where: { id: session.user.id },
      data: {
        preferences: { ...currentPrefs, ...updates } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Save text fields
  const user = await prisma.user.update({
    where: { id: session.user.id },
    data: {
      ...(persistentKnowledge !== undefined && { persistentKnowledge }),
      ...(upcomingSchedulePreferences !== undefined && { upcomingSchedulePreferences }),
    },
    select: { persistentKnowledge: true, upcomingSchedulePreferences: true, preferences: true },
  });

  // Compile free-text preferences into deterministic scheduling rules
  const prefs = (user.preferences as UserPreferences) || {};
  const tz = getUserTimezone(prefs as unknown as Record<string, unknown>);

  const compiled = await compilePreferenceRules(
    user.persistentKnowledge,
    user.upcomingSchedulePreferences,
    tz
  );

  // Store compiled rules in preferences.compiled
  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      preferences: { ...prefs, compiled } as unknown as Prisma.InputJsonValue,
    },
  });

  // Invalidate computed schedule so next request picks up new rules
  await invalidateSchedule(session.user.id);

  return NextResponse.json({ status: "updated", ambiguities: compiled.ambiguities });
}
