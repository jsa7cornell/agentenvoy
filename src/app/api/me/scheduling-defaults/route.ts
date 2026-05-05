/**
 * Lightweight writer for the four fields captured by the "primary link
 * setup" guided flow on the welcome page:
 *   - businessHoursStart / businessHoursEnd (integer hour 0–24, legacy)
 *   - businessHoursStartMinutes / businessHoursEndMinutes (canonical —
 *     minute-of-day, 30-min aligned; added 2026-04-23 per proposal
 *     `2026-04-23_primary-link-config-convergence` §3.1 Path A)
 *   - defaultDuration (minutes)
 *   - bufferMinutes (minutes)
 *
 * The tuner/preferences route already covers these, but it's an
 * orchestration-heavy endpoint (rule compilation, office-hours backfill,
 * schedule invalidation). This route is a narrow, additive writer for
 * the guided flow — each POST merges into `preferences.explicit.*` and
 * invalidates the cached schedule. No rule recompile needed since we
 * only touch scalar hour/duration/buffer fields.
 *
 * GET  → both hour and minute representations. Prefers *Minutes if set,
 *        derives from hour * 60 otherwise.
 * POST accepts EITHER shape:
 *   - `businessHoursStartMinutes` + `businessHoursEndMinutes` (canonical)
 *   - `businessHoursStart` + `businessHoursEnd` (legacy, still accepted)
 * When minutes are supplied we also backfill the hour fields
 * (Math.floor(min/60)) so legacy readers keep working. When only hours
 * are supplied we backfill the minute fields (hour * 60) so the new
 * scoring path has canonical data.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";
import { HOST_WRITE_SCOPE } from "@/lib/oauth/required-scopes";
import { DEFAULT_TIMEZONE } from "@/lib/timezone";
import { computeCalibrationDrift } from "@/lib/onboarding/drift";

type NumOrUndef = number | undefined;

function parseHour(v: unknown): NumOrUndef {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.trunc(v);
  if (n < 0 || n > 24) return undefined;
  return n;
}

/** Minute-of-day, 0–1440, must be 30-min aligned. */
function parseMinuteOfDay(v: unknown): NumOrUndef {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.trunc(v);
  if (n < 0 || n > 1440) return undefined;
  if (n % 30 !== 0) return undefined;
  return n;
}

function parseDuration(v: unknown): NumOrUndef {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const allowed = [15, 30, 45, 60, 90];
  return allowed.includes(v) ? v : undefined;
}

function parseBuffer(v: unknown): NumOrUndef {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const allowed = [0, 5, 10, 15, 30];
  return allowed.includes(v) ? v : undefined;
}

type FormatValue = "video" | "phone" | "in-person";
function parseDefaultFormat(v: unknown): FormatValue | undefined {
  return v === "video" || v === "phone" || v === "in-person" ? v : undefined;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const RETURNING_DORMANT_THRESHOLD_DAYS = 14;

  // Single Promise.all for the read fanout. We need the user row + the
  // counts that drive the welcome-variant decision (per the state matrix
  // in SPEC §3.3 — first-run / guest-first / returning-dormant /
  // active).
  const [
    user,
    linkCount,
    messageCount,
    guestSessionCount,
    participantCount,
    hostedSessionCount,
    lastChannelMessage,
    recentGuestSession,
    googleAccount,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true, meetSlug: true, name: true },
    }),
    prisma.negotiationLink.count({ where: { userId } }),
    prisma.channelMessage.count({ where: { channel: { userId } } }),
    prisma.negotiationSession.count({ where: { guestId: userId } }),
    prisma.sessionParticipant.count({ where: { userId } }),
    prisma.negotiationSession.count({ where: { hostId: userId } }),
    prisma.channelMessage.findFirst({
      where: { channel: { userId } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    // Surface the most-recent guest experience so the guest-first
    // variant can name the host ("you joined Sarah's meeting on Apr 22").
    prisma.negotiationSession.findFirst({
      where: { guestId: userId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, host: { select: { name: true } } },
    }),
    // §1n followup item (b): the guest-first welcome's "Connect Google
    // Calendar" CTA only makes sense when write scope is missing — a
    // post-guest-flow user with full read+write doesn't need to be told
    // to connect again. Pull `Account.scope` so the client can decide.
    prisma.account.findFirst({
      where: { userId, provider: "google" },
      select: { scope: true },
      orderBy: { id: "desc" },
    }),
  ]);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const e = prefs.explicit ?? {};
  // Canonical minutes; fall back to hour*60 when minutes absent (legacy
  // rows). Hour fields echoed for backward compat with existing clients.
  const bhs = e.businessHoursStart ?? 9;
  const bhe = e.businessHoursEnd ?? 17;
  const bhsMin = e.businessHoursStartMinutes ?? bhs * 60;
  const bheMin = e.businessHoursEndMinutes ?? bhe * 60;

  // Block count — structuredRules with action="block". Powers the
  // scheduling status chip (proposal 2026-04-23 §3.2 pattern a).
  const structuredRules =
    (e as { structuredRules?: Array<{ action?: string }> }).structuredRules ?? [];
  const blockCount = structuredRules.filter((r) => r.action === "block").length;

  // Seeded posture surfaces in the first-run greeting (2026-04-26+) so
  // the user sees the values we lifted from Google + the hardcoded
  // floor. Display-only on the greeting; no scoring impact.
  // Fall back to DEFAULT_TIMEZONE if explicit.timezone is missing —
  // the posture bubble's timezone bullet is always-render now (matches
  // the businessHours/duration/videoProvider fallback pattern). The
  // signup seed should populate this, but treat the bullet as a UX
  // surface and floor it rather than showing a partial bubble.
  const tz = (e as { timezone?: string }).timezone ?? DEFAULT_TIMEZONE;
  const videoProvider =
    (e as { videoProvider?: string }).videoProvider ?? "google_meet";

  // Welcome-variant resolution. See the state matrix in SPEC §3.3.
  // Order matters — the first match wins.
  type WelcomeVariant =
    | "first-run"
    | "guest-first"
    | "returning-dormant"
    | "active";
  let welcomeVariant: WelcomeVariant;
  if (messageCount > 0) {
    const lastAt = lastChannelMessage?.createdAt;
    const daysSince = lastAt
      ? (Date.now() - lastAt.getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    welcomeVariant =
      daysSince >= RETURNING_DORMANT_THRESHOLD_DAYS
        ? "returning-dormant"
        : "active";
  } else if (
    hostedSessionCount === 0 &&
    (guestSessionCount > 0 || participantCount > 0)
  ) {
    // No host messages yet, but the user already participated as a guest
    // somewhere — they came in via someone else's link first.
    welcomeVariant = "guest-first";
  } else {
    welcomeVariant = "first-run";
  }

  // guest-first context — only set when relevant; lets the client render
  // "you joined {hostName}'s meeting on {date}" without another fetch.
  const guestFirstContext =
    welcomeVariant === "guest-first" && recentGuestSession
      ? {
          hostName: recentGuestSession.host?.name ?? null,
          date: recentGuestSession.createdAt.toISOString(),
        }
      : null;

  // returning-dormant context — drift summary for the DormantReturnBubble.
  // Computed only when needed (variant is returning-dormant). Defensive:
  // if computeCalibrationDrift throws, we omit the block rather than
  // failing the whole GET. The bubble renders a degraded "no specific drift"
  // message in that case (hasDrift === false).
  let dormantContext: {
    daysSinceCalibration: number | null;
    drift: {
      timezoneDrifted: boolean;
      durationDrifted: boolean;
      googleTimezone: string | null;
      storedTimezone: string | null;
      googleDuration: number | null;
      storedDuration: number | null;
      newCalendarsAvailable: number;
    };
  } | null = null;
  if (welcomeVariant === "returning-dormant") {
    try {
      const driftAnalysis = await computeCalibrationDrift(userId);
      dormantContext = {
        daysSinceCalibration: driftAnalysis.daysSinceCalibration,
        drift: {
          timezoneDrifted: driftAnalysis.timezoneDrifted,
          durationDrifted: driftAnalysis.durationDrifted,
          googleTimezone: driftAnalysis.googleTimezone,
          storedTimezone: driftAnalysis.storedTimezone,
          googleDuration: driftAnalysis.googleDuration,
          storedDuration: driftAnalysis.storedDuration,
          newCalendarsAvailable: driftAnalysis.newCalendarsAvailable,
        },
      };
    } catch {
      // Leave dormantContext null — bubble degrades gracefully.
    }
  }

  return NextResponse.json({
    businessHoursStart: bhs,
    businessHoursEnd: bhe,
    businessHoursStartMinutes: bhsMin,
    businessHoursEndMinutes: bheMin,
    defaultDuration: e.defaultDuration ?? 30,
    bufferMinutes: e.bufferMinutes ?? 0,
    meetSlug: user.meetSlug ?? null,
    // Counts surface on the scheduling status chip.
    linkCount,
    blockCount,
    // Greeting-card display fields (2026-04-26+).
    timezone: tz,
    videoProvider,
    name: user.name ?? null,
    // Welcome-variant dispatch + context (2026-04-26+).
    welcomeVariant,
    guestFirstContext,
    // §1n followup (b) 2026-04-28: write-scope flag for the guest-first
    // CTA. True iff the user's Google account has calendar.events scope
    // granted; false (or null account) means we still need to ask.
    hasCalendarWriteScope:
      !!googleAccount?.scope && googleAccount.scope.includes(HOST_WRITE_SCOPE),
    // Calendar-selection confirmation flag (2026-05-04). FirstRunWelcome
    // gates the posture-readback bubble on this — users with 2+ calendars
    // must explicitly Submit their picker selections before we show
    // "Great, I now have what I need from your calendar." Single-calendar
    // users effectively auto-confirm in the UI.
    calendarSelectionConfirmed:
      !!(e as { calendarSelectionConfirmed?: boolean }).calendarSelectionConfirmed,
    // Dormant-return context (PR-E). Populated only when welcomeVariant is
    // "returning-dormant"; null otherwise. Drives DormantReturnBubble copy.
    dormantContext,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Resolve hour + minute shapes. Minutes win when both are supplied.
  let bhs = body.businessHoursStart !== undefined ? parseHour(body.businessHoursStart) : undefined;
  let bhe = body.businessHoursEnd !== undefined ? parseHour(body.businessHoursEnd) : undefined;
  let bhsMin =
    body.businessHoursStartMinutes !== undefined
      ? parseMinuteOfDay(body.businessHoursStartMinutes)
      : undefined;
  let bheMin =
    body.businessHoursEndMinutes !== undefined
      ? parseMinuteOfDay(body.businessHoursEndMinutes)
      : undefined;

  // Normalize: if only one shape was supplied for a given edge, derive the
  // other. If the caller asked for invalid values (e.g. non-number), we
  // leave that edge as-supplied (undefined = no write).
  if (bhsMin !== undefined && bhs === undefined) bhs = Math.floor(bhsMin / 60);
  if (bheMin !== undefined && bhe === undefined) bhe = Math.floor(bheMin / 60);
  if (bhs !== undefined && bhsMin === undefined) bhsMin = bhs * 60;
  if (bhe !== undefined && bheMin === undefined) bheMin = bhe * 60;

  const dur = body.defaultDuration !== undefined ? parseDuration(body.defaultDuration) : undefined;
  const buf = body.bufferMinutes !== undefined ? parseBuffer(body.bufferMinutes) : undefined;
  const fmt =
    body.defaultFormat !== undefined ? parseDefaultFormat(body.defaultFormat) : undefined;
  // Timezone — accept any non-empty string; validated by safeTimezone at read
  // sites. The PrimaryLinkFlow timezone step writes via this field.
  const tz =
    typeof body.timezone === "string" && body.timezone.trim().length > 0
      ? body.timezone.trim()
      : undefined;

  if (
    bhs === undefined &&
    bhe === undefined &&
    bhsMin === undefined &&
    bheMin === undefined &&
    dur === undefined &&
    buf === undefined &&
    fmt === undefined &&
    tz === undefined
  ) {
    return NextResponse.json(
      { error: "No recognized fields in payload" },
      { status: 400 },
    );
  }
  if (bhsMin !== undefined && bheMin !== undefined && bhsMin >= bheMin) {
    return NextResponse.json(
      { error: "businessHoursStart must be less than businessHoursEnd" },
      { status: 400 },
    );
  }

  const current = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true, meetSlug: true },
  });
  if (!current) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (current.preferences as UserPreferences | null) ?? {};
  const nextExplicit = {
    ...(prefs.explicit ?? {}),
    ...(tz !== undefined ? { timezone: tz, timezoneSource: "user-confirmed" } : {}),
    ...(bhs !== undefined ? { businessHoursStart: bhs } : {}),
    ...(bhe !== undefined ? { businessHoursEnd: bhe } : {}),
    ...(bhsMin !== undefined ? { businessHoursStartMinutes: bhsMin } : {}),
    ...(bheMin !== undefined ? { businessHoursEndMinutes: bheMin } : {}),
    ...(dur !== undefined ? { defaultDuration: dur } : {}),
    ...(buf !== undefined ? { bufferMinutes: buf } : {}),
    ...(fmt !== undefined ? { defaultFormat: fmt } : {}),
  };
  const nextPrefs: UserPreferences = { ...prefs, explicit: nextExplicit };

  await prisma.user.update({
    where: { id: session.user.id },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });

  // Hour-range changes affect the deterministic scoring window; invalidate.
  if (
    bhs !== undefined ||
    bhe !== undefined ||
    bhsMin !== undefined ||
    bheMin !== undefined
  ) {
    await invalidateSchedule(session.user.id);
  }

  return NextResponse.json({
    businessHoursStart: nextExplicit.businessHoursStart,
    businessHoursEnd: nextExplicit.businessHoursEnd,
    businessHoursStartMinutes: nextExplicit.businessHoursStartMinutes,
    businessHoursEndMinutes: nextExplicit.businessHoursEndMinutes,
    defaultDuration: nextExplicit.defaultDuration,
    bufferMinutes: nextExplicit.bufferMinutes,
    meetSlug: current.meetSlug ?? null,
  });
}
