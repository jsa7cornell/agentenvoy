import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { invalidateSchedule } from "@/lib/calendar";
import {
  OnboardingPhase,
  OnboardingContext,
  getIntroMessages,
  getTimezonePickerMessages,
  getTimezoneInputMessages,
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
export async function GET() {
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

  const prefs = (user.preferences as UserPreferences) || {};
  const tz = getUserTimezone(prefs as unknown as Record<string, unknown>);

  const ctx: OnboardingContext = {
    userName: user.name || undefined,
    detectedTimezone: tz,
    meetSlug: user.meetSlug || undefined,
  };

  // Resume at saved phase or start fresh
  const phase = (user.onboardingPhase as OnboardingPhase) || "intro";

  // Wow-factor calendar read — best-effort, only on the intro phase.
  // Generated fresh on each GET so a user who refreshes gets a new riff;
  // if it's slow or fails, onboarding still renders without it.
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
  };

  // ── Handle response for current phase ─────────────────────────────────

  switch (currentPhase) {
    case "intro": {
      if (response === "change_tz") {
        advancing = false;
        result = getTimezonePickerMessages();
        return await respondWithPersist(user.id, result);
      }
      if (response === "other_tz") {
        // Show free-text timezone input
        advancing = false;
        result = getTimezoneInputMessages();
        return await respondWithPersist(user.id, result);
      }
      // Validate timezone — if invalid, ask again
      const selectedTz = response || tz;
      const validatedTz = safeTimezone(selectedTz);
      if (validatedTz !== selectedTz && response) {
        // User typed an invalid timezone — show error and re-prompt
        advancing = false;
        result = {
          phase: "intro",
          messages: [{ content: `"${response}" isn't a recognized timezone. Try the format **Continent/City** (e.g. America/New_York, Europe/Berlin).` }],
          placeholder: "America/New_York",
        };
        return await respondWithPersist(user.id, result);
      }
      await updatePrefs(user.id, prefs, explicit, { timezone: validatedTz });
      ctx.detectedTimezone = validatedTz;
      break;
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
      const link = (response || "").trim();
      if (link) {
        const freshPrefs = await getFreshPrefs(user.id);
        await updatePrefs(user.id, freshPrefs.prefs, freshPrefs.explicit, { zoomLink: link });
      }
      break;
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

  result = getMessagesForPhase(next, ctx);
  return await respondWithPersist(user.id, result);
}

// ── Helpers ────────────────────────────────────────────────────────────

function getMessagesForPhase(phase: OnboardingPhase, ctx: OnboardingContext): PhaseResult {
  switch (phase) {
    case "intro": return getIntroMessages(ctx);
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
}
