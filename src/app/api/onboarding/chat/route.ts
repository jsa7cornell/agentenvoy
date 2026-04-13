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
  getDefaultsFormatMessages,
  getPhoneNumberMessages,
  getZoomLinkMessages,
  getDefaultsDurationMessages,
  getDefaultsBufferMessages,
  getCalendarRulesMessages,
  getCalendarEveningsMessages,
  getCompleteMessages,
  nextPhase,
  PhaseResult,
} from "@/lib/onboarding-machine";
import type { AvailabilityRule } from "@/lib/availability-rules";
import { safeTimezone } from "@/lib/utils";

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
  const tz = safeTimezone(prefs.explicit?.timezone ?? prefs.timezone);

  const ctx: OnboardingContext = {
    userName: user.name || undefined,
    detectedTimezone: tz,
    meetSlug: user.meetSlug || undefined,
  };

  // Resume at saved phase or start fresh
  const phase = (user.onboardingPhase as OnboardingPhase) || "intro";

  const result = getMessagesForPhase(phase, ctx);
  return NextResponse.json({ ...result, currentPhase: phase });
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
  const { phase: currentPhase, response } = body as {
    phase: OnboardingPhase;
    response?: string;
  };

  const prefs = (user.preferences as UserPreferences) || {};
  const explicit = prefs.explicit || {};
  const tz = safeTimezone(explicit.timezone ?? prefs.timezone);

  let advancing = true;
  let result: PhaseResult;
  // Track which conditional phases to skip
  let skipPhoneNumber = false;
  let skipZoomLink = false;

  const ctx: OnboardingContext = {
    userName: user.name || undefined,
    detectedTimezone: tz,
    meetSlug: user.meetSlug || undefined,
  };

  // ── Handle response for current phase ─────────────────────────────────

  switch (currentPhase) {
    case "intro": {
      if (response === "change_tz") {
        // User wants to change timezone — show free text input (stay on intro phase)
        advancing = false;
        result = getTimezonePickerMessages();
        return NextResponse.json(result);
      }
      // Either confirmed timezone or typed a custom one
      const selectedTz = safeTimezone(response || tz);
      await updatePrefs(user.id, prefs, explicit, { timezone: selectedTz });
      ctx.detectedTimezone = selectedTz;
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
      const [startH, endH] = (response || "9-17").split("-").map(Number);
      const freshPrefs = await getFreshPrefs(user.id);
      await updatePrefs(user.id, freshPrefs.prefs, freshPrefs.explicit, {
        businessHoursStart: startH,
        businessHoursEnd: endH,
      });
      break;
    }

    case "calendar_evenings": {
      // Save evening preference to knowledge
      const pk = user.persistentKnowledge || "";
      let entry = "";
      if (response === "blocked") entry = "- Evenings: only offer evening meetings with host's explicit permission";
      else if (response === "open") entry = "- Evenings are open for scheduling";
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
      return NextResponse.json({ ...result, onboardingComplete: true });
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

  await savePhase(user.id, next);

  result = getMessagesForPhase(next, ctx);
  return NextResponse.json(result);
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

async function completeOnboarding(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      lastCalibratedAt: new Date(),
      onboardingPhase: "complete",
    },
  });

  await invalidateSchedule(userId);
}
