import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { invalidateSchedule } from "@/lib/calendar";
import { track } from "@/lib/analytics/track";
import {
  OnboardingPhase,
  OnboardingContext,
  getIntroMessages,
  getDefaultsFormatMessages,
  getPhoneNumberMessages,
  getZoomLinkMessages,
  getDefaultsDurationMessages,
  getDefaultsBufferMessages,
  getCalendarRulesMessages,
  getCalendarRulesCustomMessages,
  getCalendarEveningsMessages,
  getCompleteMessages,
  nextPhase,
  PhaseResult,
} from "@/lib/onboarding-machine";
import type { AvailabilityRule } from "@/lib/availability-rules";
import { safeTimezone, getUserTimezone } from "@/lib/timezone";
import { generateOnboardingCalendarRead } from "@/lib/calendar-read";
import { logCalibrationWrite } from "@/lib/calibration-audit";
import { parseCustomBusinessHours } from "./_parse-business-hours";
import {
  emitOnboardingEntered,
  emitOnboardingCompleted,
} from "@/lib/onboarding/events";
import {
  ENTRY_POINT_COOKIE,
  type HostEntryPoint,
} from "@/lib/oauth/required-scopes";
import { buildSeededExplicit } from "@/lib/onboarding/seed-defaults";

interface UserPreferences {
  timezone?: string;
  explicit?: {
    timezone?: string;
    businessHoursStart?: number;
    businessHoursEnd?: number;
    bufferMinutes?: number;
    defaultDuration?: number;
    defaultFormat?: string;
    videoProvider?: string;
    zoomLink?: string;
    schedulingPosture?: string;
    structuredRules?: AvailabilityRule[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * GET /api/onboarding/chat — returns current onboarding state + initial messages
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: {
      id: true,
      name: true,
      meetSlug: true,
      preferences: true,
      lastCalibratedAt: true,
      onboardingPhase: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Already completed
  if (user.lastCalibratedAt) {
    return NextResponse.json({ phase: "complete", messages: [], redirect: "/dashboard" });
  }

  let prefs = (user.preferences as UserPreferences) || {};

  // Resume at saved phase or start fresh
  const isFreshRun = !user.onboardingPhase;
  const phase = (user.onboardingPhase as OnboardingPhase) || "intro";

  // Browser-tz seeding — only on fresh run and only when the user's
  // current stored tz came from a weak source (no Google Calendar tz
  // seeded at createUser yet). Validated via `safeTimezone`; invalid
  // input is ignored. Stamped `explicit.timezoneSource = "browser-detected"`
  // so a later calendar-read can overwrite if it finds something better.
  if (isFreshRun) {
    const browserTz = req.nextUrl.searchParams.get("browserTz");
    const hasExplicitTz = typeof prefs.explicit?.timezone === "string";
    if (browserTz && !hasExplicitTz) {
      const safe = safeTimezone(browserTz);
      if (safe === browserTz) {
        const merged: UserPreferences = {
          ...prefs,
          explicit: {
            ...(prefs.explicit || {}),
            timezone: safe,
            timezoneSource: "browser-detected",
          },
        };
        await prisma.user.update({
          where: { id: user.id },
          data: { preferences: merged as unknown as Prisma.InputJsonValue },
        });
        prefs = merged;
      }
    }
  }

  const tz = getUserTimezone(prefs as unknown as Record<string, unknown>);

  const ctx: OnboardingContext = {
    userName: user.name || undefined,
    detectedTimezone: tz,
    meetSlug: user.meetSlug || undefined,
    seededDefaults: mergeSeededDefaults(prefs.explicit),
  };

  // Fire onboarding.entered once per fresh run. The events helper dedupes
  // within 24h via the OnboardingEvent table, so double-GETs (StrictMode,
  // refresh) don't double-count.
  if (isFreshRun) {
    const entryPoint = readEntryPointCookie();
    const hasReturnTo = req.nextUrl.searchParams.get("hasReturnTo") === "1";
    void emitOnboardingEntered({ userId: user.id, entryPoint, hasReturnTo });
  }

  // Wow-factor calendar read — best-effort, only on the intro phase.
  // Generated fresh on each GET so a user who refreshes gets a new riff;
  // if it's slow or fails, onboarding still renders without it. Kept in
  // place (intro has no blocking quick-replies post-tz-ask-removal, so
  // GET latency no longer races against the user's first freetext turn).
  if (phase === "intro") {
    const paragraph = await generateOnboardingCalendarRead(
      user.id,
      tz,
      user.name || undefined
    );
    if (paragraph) ctx.calendarReadParagraph = paragraph;
  }

  const result = getMessagesForPhase(phase, ctx);
  // Persist the intro message only once per onboarding run so repeated GETs
  // (page reloads during onboarding) don't stack duplicates.
  const existingOnboardingCount = await countOnboardingMessages(user.id);
  if (existingOnboardingCount === 0) {
    for (const m of result.messages) {
      if (m.content) await persistOnboardingTurn(user.id, "envoy", m.content);
    }
  }
  return NextResponse.json({ ...result, currentPhase: phase });
}

async function countOnboardingMessages(userId: string): Promise<number> {
  const channel = await prisma.channel.findUnique({ where: { userId } });
  if (!channel) return 0;
  return await prisma.channelMessage.count({
    where: {
      channelId: channel.id,
      metadata: { path: ["kind"], equals: "onboarding" },
    },
  });
}

/**
 * POST /api/onboarding/chat — process user response, advance phase
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: {
      id: true,
      name: true,
      email: true,
      meetSlug: true,
      preferences: true,
      persistentKnowledge: true,
      lastCalibratedAt: true,
      onboardingPhase: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json();
  const { phase: currentPhase, response, responseLabel } = body as {
    phase: OnboardingPhase;
    response?: string;
    /** Human-readable version of `response` for quick-reply clicks (the label
     *  the user actually saw). For freetext responses this is undefined and
     *  `response` is used verbatim. */
    responseLabel?: string;
  };

  // Persist the user's turn to the channel so onboarding history survives
  // page reload. Skip "auto" responses (client-side auto-advance pings) and
  // empty responses. We intentionally persist BEFORE we process so that even
  // an error path leaves the user's input visible in the transcript.
  if (response && response !== "auto") {
    await persistOnboardingTurn(user.id, "user", responseLabel || response);
  }

  const prefs = (user.preferences as UserPreferences) || {};
  const explicit = prefs.explicit || {};
  const tz = getUserTimezone(prefs as unknown as Record<string, unknown>);

  let advancing = true;
  let result: PhaseResult;
  // Track which conditional phases to skip
  let skipPhoneNumber = false;
  let skipZoomLink = false;
  let skipCustomHours = false;

  const ctx: OnboardingContext = {
    userName: user.name || undefined,
    detectedTimezone: tz,
    meetSlug: user.meetSlug || undefined,
    seededDefaults: mergeSeededDefaults(explicit),
  };

  // ── Handle response for current phase ─────────────────────────────────

  switch (currentPhase) {
    case "intro": {
      // Intro auto-advances — no blocking tz ask. Tz is seeded from the
      // browser (GET `?browserTz=`) or Google Calendar at createUser and is
      // correctable in normal chat later. Any response reaching this case
      // is the client's auto-advance ping; just persist the seeded tz so
      // `explicit.timezone` is set before the next phase.
      const seededTz = safeTimezone(tz);
      await updatePrefs(user.id, prefs, explicit, { timezone: seededTz });
      ctx.detectedTimezone = seededTz;
      break;
    }

    case "defaults_confirm": {
      // Legacy path — the `defaults_confirm` phase was sunset 2026-04-23
      // (proposal `2026-04-23_primary-link-config-convergence` §4 V1 item 5).
      // In-flight users whose stored phase is still `defaults_confirm`
      // complete immediately; the new `complete` message inlines the
      // seed-preview bubble. Zoom preference is handled via dashboard chat
      // after onboarding completes.
      await completeOnboarding(user.id);
      result = getCompleteMessages(ctx);
      await savePhase(user.id, "complete");
      return await respondWithPersist(user.id, result, { onboardingComplete: true });
    }

    case "defaults_format": {
      if (response === "phone") {
        await updatePrefs(user.id, prefs, explicit, { defaultFormat: "phone" });
        skipZoomLink = true;
      } else if (response === "zoom") {
        await updatePrefs(user.id, prefs, explicit, { defaultFormat: "video", videoProvider: "zoom" });
        skipPhoneNumber = true;
      } else if (response === "google_meet") {
        await updatePrefs(user.id, prefs, explicit, { defaultFormat: "video", videoProvider: "google_meet" });
        skipPhoneNumber = true;
        skipZoomLink = true;
      } else {
        const format = response === "none" ? undefined : response;
        await updatePrefs(user.id, prefs, explicit, { defaultFormat: format });
        skipPhoneNumber = true;
        skipZoomLink = true;
      }
      break;
    }

    case "phone_number": {
      const phoneNum = (response || "").trim();
      if (phoneNum) {
        await updatePrefs(user.id, prefs, explicit, { phone: phoneNum });
      }
      // Always skip zoom_link after phone_number (user chose phone, not zoom)
      skipZoomLink = true;
      break;
    }

    case "zoom_link": {
      // After the user lands on this phase (only reachable via the "Use Zoom
      // instead" branch off defaults_confirm in the current flow), accept the
      // link if provided and complete onboarding. Previously this fell
      // through to nextPhase() which routed back to defaults_confirm (legacy
      // of the old linear flow) — the explicit complete here avoids that.
      const link = (response || "").trim();
      if (link) {
        const freshPrefs = await getFreshPrefs(user.id);
        await updatePrefs(user.id, freshPrefs.prefs, freshPrefs.explicit, { zoomLink: link });
      }
      await completeOnboarding(user.id);
      result = getCompleteMessages(ctx);
      await savePhase(user.id, "complete");
      return await respondWithPersist(user.id, result, { onboardingComplete: true });
    }

    case "defaults_duration": {
      const duration = parseInt(response || "30", 10);
      const freshPrefs = await getFreshPrefs(user.id);
      await updatePrefs(user.id, freshPrefs.prefs, freshPrefs.explicit, { defaultDuration: duration });
      break;
    }

    case "defaults_buffer": {
      const buffer = parseInt(response || "0", 10);
      if (buffer > 0) {
        const freshPrefs = await getFreshPrefs(user.id);
        const bufferRule: AvailabilityRule = {
          id: `rule_onboard_buffer_${Date.now()}`,
          originalText: `buffer ${buffer} min after all meetings`,
          type: "ongoing",
          action: "buffer",
          bufferMinutesAfter: buffer,
          bufferAppliesTo: "all",
          status: "active",
          priority: 3,
          createdAt: new Date().toISOString(),
        };
        const existingRules = (freshPrefs.explicit.structuredRules as AvailabilityRule[]) ?? [];
        await updatePrefs(user.id, freshPrefs.prefs, freshPrefs.explicit, {
          structuredRules: [...existingRules, bufferRule],
        });
      }
      break;
    }

    case "calendar_rules": {
      if (response === "custom_hours") {
        // Fall through to the freetext custom-hours phase without writing.
        advancing = true;
        break;
      }
      const [startH, endH] = (response || "9-17").split("-").map(Number);
      const freshPrefs = await getFreshPrefs(user.id);
      await updatePrefs(user.id, freshPrefs.prefs, freshPrefs.explicit, {
        businessHoursStart: startH,
        businessHoursEnd: endH,
      });
      skipCustomHours = true;
      break;
    }

    case "calendar_rules_custom": {
      const parsed = parseCustomBusinessHours(response || "");
      if (!parsed) {
        advancing = false;
        result = {
          phase: "calendar_rules_custom",
          messages: [
            {
              content: `I couldn't parse "${response}". Try a format like "9am-5pm", "8:30 - 17:30", or "9-18".`,
            },
          ],
          placeholder: "8:30am – 5:30pm",
        };
        return await respondWithPersist(user.id, result);
      }
      const freshPrefs = await getFreshPrefs(user.id);
      // Scoring uses hour-granularity; round start down and end up so a
      // "8:30 - 5:30pm" user still has their whole working window covered.
      const startH = parsed.startH;
      const endH = parsed.endMin && parsed.endMin > 0 ? parsed.endH + 1 : parsed.endH;
      await updatePrefs(user.id, freshPrefs.prefs, freshPrefs.explicit, {
        businessHoursStart: startH,
        businessHoursEnd: Math.min(endH, 24),
      });
      break;
    }

    case "calendar_evenings": {
      // Save evenings-and-early-mornings posture to knowledge. Three postures:
      //   - protected: never offer outside business hours without explicit say-so
      //   - vip_only:  protected by default, but OK to surface (with
      //                confirmation) for VIP / high-priority guests
      //   - open:      fine to offer evenings/early mornings freely
      // Legacy "blocked" is treated as "protected" so older rows still load.
      const pk = user.persistentKnowledge || "";
      let entry = "";
      if (response === "protected" || response === "blocked") {
        entry = "- Evenings and early mornings: protected — never offer outside normal business hours without the host's explicit direction.";
      } else if (response === "vip_only") {
        entry = "- Evenings and early mornings: protected by default, but for VIP or high-priority guests you may surface an out-of-hours slot as 'this is outside your normal hours — want me to offer it anyway?' Never include silently.";
      } else if (response === "open") {
        entry = "- Evenings and early mornings are open for scheduling.";
      }
      if (entry) {
        await prisma.user.update({
          where: { id: user.id },
          data: { persistentKnowledge: pk ? `${pk}\n${entry}` : entry },
        });
      }
      // This is the last phase before complete
      await completeOnboarding(user.id);
      result = getCompleteMessages(ctx);
      await savePhase(user.id, "complete");
      return await respondWithPersist(user.id, result, { onboardingComplete: true });
    }

    case "complete": {
      return NextResponse.json({ phase: "complete", messages: [], onboardingComplete: true });
    }
  }

  // Advance to next phase
  let next = advancing ? nextPhase(currentPhase) : currentPhase;

  // Skip conditional phases based on format choice
  if (next === "phone_number" && skipPhoneNumber) {
    next = nextPhase("phone_number");
  }
  if (next === "zoom_link" && skipZoomLink) {
    next = nextPhase("zoom_link");
  }
  if (next === "calendar_rules_custom" && skipCustomHours) {
    next = nextPhase("calendar_rules_custom");
  }

  await savePhase(user.id, next);

  // Intro now advances straight to `complete` (2026-04-23 sunset of the
  // `defaults_confirm` phase). Mark onboarding complete so the client
  // transitions into the dashboard surface and the welcome-page's 🔗
  // primary-link flow becomes the tune affordance.
  if (next === "complete") {
    await completeOnboarding(user.id);
    result = getCompleteMessages(ctx);
    return await respondWithPersist(user.id, result, { onboardingComplete: true });
  }

  result = getMessagesForPhase(next, ctx);
  return await respondWithPersist(user.id, result);
}

// ── Helpers ────────────────────────────────────────────────────────────

function getMessagesForPhase(phase: OnboardingPhase, ctx: OnboardingContext): PhaseResult {
  switch (phase) {
    case "intro": return getIntroMessages(ctx);
    // Sunset phase — if a stored legacy value reaches this dispatcher,
    // render the complete message (which inlines the seed-preview bubble).
    case "defaults_confirm": return getCompleteMessages(ctx);
    case "defaults_format": return getDefaultsFormatMessages();
    case "phone_number": return getPhoneNumberMessages();
    case "zoom_link": return getZoomLinkMessages();
    case "defaults_duration": return getDefaultsDurationMessages();
    case "defaults_buffer": return getDefaultsBufferMessages();
    case "calendar_rules": return getCalendarRulesMessages();
    case "calendar_rules_custom": return getCalendarRulesCustomMessages();
    case "calendar_evenings": return getCalendarEveningsMessages();
    case "complete": return getCompleteMessages(ctx);
    default: return getIntroMessages(ctx);
  }
}

async function savePhase(userId: string, phase: OnboardingPhase) {
  await prisma.user.update({
    where: { id: userId },
    data: { onboardingPhase: phase },
  });
  await track({
    name: "onboarding.phase_entered",
    userId,
    props: { phase },
  });
}

async function getFreshPrefs(userId: string) {
  const freshUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const prefs = (freshUser?.preferences as UserPreferences) || {};
  const explicit = prefs.explicit || {};
  return { prefs, explicit };
}

async function updatePrefs(
  userId: string,
  prefs: UserPreferences,
  explicit: NonNullable<UserPreferences["explicit"]>,
  updates: Record<string, unknown>
) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      preferences: {
        ...prefs,
        explicit: { ...explicit, ...updates },
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

// parseCustomBusinessHours lives in ./_parse-business-hours — App Router
// route files can only export HTTP verbs.

/**
 * Persist one onboarding turn as a ChannelMessage so history survives page
 * reload and reviewing past settings decisions is possible. Metadata tags
 * kind="onboarding" so the client can filter/collapse if needed.
 */
async function persistOnboardingTurn(
  userId: string,
  role: "user" | "envoy",
  content: string,
) {
  let channel = await prisma.channel.findUnique({ where: { userId } });
  if (!channel) channel = await prisma.channel.create({ data: { userId } });
  await prisma.channelMessage.create({
    data: {
      channelId: channel.id,
      role,
      content,
      metadata: { kind: "onboarding" },
    },
  });
}

/**
 * Shared exit point for onboarding handlers: persist the envoy messages
 * we're about to return, then emit the JSON response. The user's prior
 * turn was already persisted at the top of POST.
 */
async function respondWithPersist(
  userId: string,
  result: PhaseResult,
  extras: Record<string, unknown> = {},
) {
  for (const m of result.messages) {
    if (m.content) await persistOnboardingTurn(userId, "envoy", m.content);
  }
  return NextResponse.json({ ...result, ...extras });
}

async function completeOnboarding(userId: string) {
  const now = new Date();
  logCalibrationWrite({ userId, value: now, source: "onboarding-complete" });
  await prisma.user.update({
    where: { id: userId },
    data: {
      lastCalibratedAt: now,
      onboardingPhase: "complete",
    },
  });

  await invalidateSchedule(userId);
  await track({ name: "onboarding.completed", userId });
  await emitOnboardingCompleted({ userId });

  // Cookie-hint for returning users. Presence of `ae_returning=1` lets
  // `useOAuthSignIn` skip the pre-consent explainer on `mode: "login"` and
  // use `prompt: "select_account"` instead of forcing consent every sign-in.
  try {
    cookies().set(RETURNING_COOKIE, "1", {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
    });
  } catch {
    // cookies().set throws outside request scope — onboarding completes
    // inside a request, but belt-and-suspenders for future callers.
  }
}

const RETURNING_COOKIE = "ae_returning";

function readEntryPointCookie(): HostEntryPoint {
  try {
    const ep = cookies().get(ENTRY_POINT_COOKIE)?.value;
    if (ep === "deal-room" || ep === "deal-room-upsell") return ep;
  } catch {
    // fall through
  }
  return "front-door";
}

/**
 * Merge explicit prefs into the defaults-confirm view shape. Falls back to
 * `buildSeededExplicit()` values so the confirm card has something sensible
 * to render even if the createUser seed didn't run (e.g. very-old users).
 */
function mergeSeededDefaults(
  explicit: UserPreferences["explicit"] | undefined,
): OnboardingContext["seededDefaults"] {
  const seed = buildSeededExplicit({});
  return {
    businessHoursStart:
      (explicit?.businessHoursStart as number | undefined) ??
      (seed.businessHoursStart as number | undefined),
    businessHoursEnd:
      (explicit?.businessHoursEnd as number | undefined) ??
      (seed.businessHoursEnd as number | undefined),
    defaultFormat:
      (explicit?.defaultFormat as string | undefined) ??
      (seed.defaultFormat as string | undefined),
    videoProvider:
      (explicit?.videoProvider as string | undefined) ??
      (seed.videoProvider as string | undefined),
    defaultDuration:
      (explicit?.defaultDuration as number | undefined) ??
      (seed.defaultDuration as number | undefined),
    bufferMinutes:
      (explicit?.bufferMinutes as number | undefined) ??
      (seed.bufferMinutes as number | undefined),
  };
}
