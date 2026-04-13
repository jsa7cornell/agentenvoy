import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule, invalidateSchedule } from "@/lib/calendar";
import { getStubSchedule } from "@/lib/fixtures/stub-calendar";
import {
  OnboardingPhase,
  OnboardingContext,
  getIntroMessages,
  getTimezoneMessages,
  getCalendarRevealMessages,
  pickEventQuestions,
  getEventQuestion,
  getEveningQuestion,
  getProtectionMessages,
  getProtectionDurationMessages,
  getProtectionBlocksMessages,
  getHoursMessages,
  getHoursPostureMessages,
  getFormatMessages,
  getSimulationMessages,
  getSimulationWalkthroughMessages,
  getCompletionMessages,
  nextPhase,
  PhaseResult,
} from "@/lib/onboarding-machine";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";

interface UserPreferences {
  timezone?: string;
  explicit?: {
    timezone?: string;
    businessHoursStart?: number;
    businessHoursEnd?: number;
    bufferMinutes?: number;
    defaultDuration?: number;
    defaultFormat?: string;
    schedulingPosture?: string;
    blockedWindows?: Array<{
      start: string;
      end: string;
      days?: string[];
      label?: string;
      expires?: string;
    }>;
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
  const tz = prefs.explicit?.timezone ?? prefs.timezone ?? "America/Los_Angeles";

  const ctx: OnboardingContext = {
    userName: user.name || undefined,
    detectedTimezone: tz,
    meetSlug: user.meetSlug || undefined,
  };

  // Resume at saved phase or start fresh
  const phase = (user.onboardingPhase as OnboardingPhase) || "intro";

  // For calendar phases, load schedule data
  let scheduleData: Awaited<ReturnType<typeof getOrComputeSchedule>> | null = null;
  if (["calendar_reveal", "events"].includes(phase)) {
    scheduleData = await loadSchedule(user.id, tz);
    ctx.slots = scheduleData.slots;
    ctx.events = scheduleData.events;
  }

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
      upcomingSchedulePreferences: true,
      lastCalibratedAt: true,
      onboardingPhase: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json();
  const { phase: currentPhase, response, timezoneValue, eventAnswers } = body as {
    phase: OnboardingPhase;
    response?: string;
    timezoneValue?: string; // for timezone picker
    eventAnswers?: Array<{ eventId: string; answer: string }>; // for batch event answers
  };

  const prefs = (user.preferences as UserPreferences) || {};
  const explicit = prefs.explicit || {};
  const tz = explicit.timezone ?? prefs.timezone ?? "America/Los_Angeles";

  let advancing = true;
  let result: PhaseResult;

  const ctx: OnboardingContext = {
    userName: user.name || undefined,
    detectedTimezone: tz,
    meetSlug: user.meetSlug || undefined,
  };

  // ── Handle response for current phase and determine next ──

  switch (currentPhase) {
    case "intro": {
      // User tapped "Let's go"
      break;
    }

    case "timezone": {
      const selectedTz = timezoneValue || response;
      if (selectedTz && selectedTz !== "custom") {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            preferences: {
              ...prefs,
              explicit: { ...explicit, timezone: selectedTz },
            },
          },
        });
        ctx.detectedTimezone = selectedTz;
      }
      // If "custom", the client will show a timezone picker and re-submit with timezoneValue
      if (response === "custom" && !timezoneValue) {
        advancing = false;
        result = getTimezoneMessages(ctx);
        result.widget = { type: "timezone-picker", data: { current: tz } };
        return NextResponse.json(result);
      }
      break;
    }

    case "calendar_reveal": {
      // User saw the calendar and tapped "Got it"
      // Load schedule for event questions
      const schedule = await loadSchedule(user.id, tz);
      ctx.slots = schedule.slots;
      ctx.events = schedule.events;
      break;
    }

    case "events": {
      // Event answers come as batch from client
      if (eventAnswers && eventAnswers.length > 0) {
        const knowledge: string[] = [];
        for (const ea of eventAnswers) {
          if (ea.answer === "protect") {
            knowledge.push(`- Event "${ea.eventId}" should always be protected (score 4+)`);
          } else if (ea.answer === "soft") {
            knowledge.push(`- Event "${ea.eventId}" is a soft hold — offer if the meeting is important`);
          } else if (ea.answer === "flexible" || ea.answer === "movable") {
            knowledge.push(`- Event "${ea.eventId}" is flexible and can be offered or rescheduled`);
          } else if (ea.answer === "blocked") {
            knowledge.push(`- Evenings should be kept off-limits for scheduling`);
          } else if (ea.answer === "phone_only") {
            knowledge.push(`- Evenings are only available for phone calls, not video`);
          } else if (ea.answer === "open") {
            knowledge.push(`- Evenings are open for scheduling`);
          }
        }
        if (knowledge.length > 0) {
          const existing = user.persistentKnowledge || "";
          const updated = existing
            ? `${existing}\n${knowledge.join("\n")}`
            : knowledge.join("\n");
          await prisma.user.update({
            where: { id: user.id },
            data: { persistentKnowledge: updated },
          });
        }
      }
      break;
    }

    case "protection": {
      // Buffer minutes
      const buffer = parseInt(response || "0", 10);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          preferences: {
            ...prefs,
            explicit: { ...explicit, bufferMinutes: buffer },
          },
        },
      });
      break;
    }

    case "protection_duration": {
      const duration = parseInt(response || "30", 10);
      // Re-read prefs since buffer was just saved
      const freshUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { preferences: true },
      });
      const freshPrefs = (freshUser?.preferences as UserPreferences) || {};
      const freshExplicit = freshPrefs.explicit || {};
      await prisma.user.update({
        where: { id: user.id },
        data: {
          preferences: {
            ...freshPrefs,
            explicit: { ...freshExplicit, defaultDuration: duration },
          },
        },
      });
      break;
    }

    case "protection_blocks": {
      // Parse freeform text into blocked windows
      const text = (response || "").trim().toLowerCase();
      if (text && text !== "nothing" && text !== "none" && text !== "no" && text !== "skip") {
        // Use LLM to parse into structured blocked windows
        try {
          const parseResult = await generateText({
            model: envoyModel("claude-sonnet-4-6"),
            system: `Parse the user's text into structured blocked windows for a scheduling system. Return valid JSON only — an array of objects with: { start: "HH:MM", end: "HH:MM", days?: ["Mon","Tue",...], label: string, recurring: boolean }. Use 24-hour time. If you can't parse it, return [].`,
            messages: [{ role: "user", content: response! }],
          });
          const windows = JSON.parse(parseResult.text);
          if (Array.isArray(windows) && windows.length > 0) {
            const freshUser2 = await prisma.user.findUnique({
              where: { id: user.id },
              select: { preferences: true },
            });
            const fp = (freshUser2?.preferences as UserPreferences) || {};
            const fe = fp.explicit || {};
            const existing = fe.blockedWindows || [];
            await prisma.user.update({
              where: { id: user.id },
              data: {
                preferences: {
                  ...fp,
                  explicit: {
                    ...fe,
                    blockedWindows: [...existing, ...windows],
                  },
                },
              },
            });
          }
        } catch (e) {
          console.error("Failed to parse blocked windows:", e);
          // Save as knowledge instead
          const existing = user.persistentKnowledge || "";
          await prisma.user.update({
            where: { id: user.id },
            data: {
              persistentKnowledge: existing
                ? `${existing}\n- Protected time: ${response}`
                : `- Protected time: ${response}`,
            },
          });
        }
      }
      break;
    }

    case "hours": {
      if (response === "custom") {
        // Client will show hours picker and re-submit with specific values
        advancing = false;
        result = getHoursMessages();
        result.widget = { type: "hours-picker", data: { start: 9, end: 17 } };
        return NextResponse.json(result);
      }
      const [startH, endH] = (response || "9-17").split("-").map(Number);
      const freshUser3 = await prisma.user.findUnique({
        where: { id: user.id },
        select: { preferences: true },
      });
      const fp3 = (freshUser3?.preferences as UserPreferences) || {};
      const fe3 = fp3.explicit || {};
      await prisma.user.update({
        where: { id: user.id },
        data: {
          preferences: {
            ...fp3,
            explicit: { ...fe3, businessHoursStart: startH, businessHoursEnd: endH },
          },
        },
      });
      break;
    }

    case "hours_posture": {
      const freshUser4 = await prisma.user.findUnique({
        where: { id: user.id },
        select: { preferences: true, persistentKnowledge: true },
      });
      const fp4 = (freshUser4?.preferences as UserPreferences) || {};
      const fe4 = fp4.explicit || {};
      await prisma.user.update({
        where: { id: user.id },
        data: {
          preferences: {
            ...fp4,
            explicit: { ...fe4, schedulingPosture: response || "balanced" },
          },
        },
      });
      // Also save to persistent knowledge for the LLM
      const postureLabel =
        response === "generous" ? "generous — offer whatever's open" :
        response === "conservative" ? "conservative — only clearly open slots" :
        "balanced — offer open slots, check before moving things";
      const pk = freshUser4?.persistentKnowledge || "";
      await prisma.user.update({
        where: { id: user.id },
        data: {
          persistentKnowledge: pk
            ? `${pk}\n- Scheduling posture: ${postureLabel}`
            : `- Scheduling posture: ${postureLabel}`,
        },
      });
      break;
    }

    case "format": {
      const freshUser5 = await prisma.user.findUnique({
        where: { id: user.id },
        select: { preferences: true },
      });
      const fp5 = (freshUser5?.preferences as UserPreferences) || {};
      const fe5 = fp5.explicit || {};
      const format = response === "none" ? undefined : response;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          preferences: {
            ...fp5,
            explicit: { ...fe5, defaultFormat: format },
          },
        },
      });
      break;
    }

    case "simulation": {
      // User tapped "Show me what it looks like"
      const schedule = await loadSchedule(user.id, tz);
      ctx.slots = schedule.slots;
      break;
    }

    case "simulation_walkthrough": {
      // User tapped "Got it, take me to the dashboard" — complete onboarding
      await completeOnboarding(user.id, user.meetSlug || "");
      result = getCompletionMessages(ctx);
      await savePhase(user.id, "complete");
      return NextResponse.json({ ...result, redirect: "/dashboard" });
    }

    case "complete": {
      return NextResponse.json({ phase: "complete", messages: [], redirect: "/dashboard" });
    }
  }

  // Advance to next phase
  const next = advancing ? nextPhase(currentPhase) : currentPhase;
  await savePhase(user.id, next);

  // Load schedule data if needed for next phase
  if (["calendar_reveal", "events", "simulation", "simulation_walkthrough"].includes(next)) {
    const schedule = await loadSchedule(user.id, tz);
    ctx.slots = schedule.slots;
    ctx.events = schedule.events;
  }

  result = getMessagesForPhase(next, ctx);

  // For events phase, pick interesting events and generate questions
  if (next === "events" && ctx.events) {
    const picks = pickEventQuestions(ctx.events);
    const eventMessages = picks.map((event) => getEventQuestion(event));
    // Check if we should ask about evenings (no evening event in picks)
    const hasEvening = picks.some((e) => {
      const h = e.start instanceof Date ? e.start.getHours() : new Date(e.start).getHours();
      return h >= 17;
    });
    if (!hasEvening) {
      eventMessages.push(getEveningQuestion());
    }
    result = {
      phase: "events",
      messages: [
        { content: "Let's walk through some of your actual events so I know how to handle them.", delay: 0 },
        ...eventMessages.map((m, i) => ({ ...m, delay: (i + 1) * 800 })),
      ],
    };
    // Include event IDs so client can send back answers keyed by event
    (result as PhaseResult & { eventIds?: string[] }).eventIds = picks.map((e) => e.summary);
  }

  return NextResponse.json(result);
}

// ── Helpers ────────────────────────────────────────────────────────────

function getMessagesForPhase(phase: OnboardingPhase, ctx: OnboardingContext): PhaseResult {
  switch (phase) {
    case "intro": return getIntroMessages(ctx);
    case "timezone": return getTimezoneMessages(ctx);
    case "calendar_reveal": return getCalendarRevealMessages(ctx);
    case "events": return { phase: "events", messages: [] }; // filled dynamically above
    case "protection": return getProtectionMessages();
    case "protection_duration": return getProtectionDurationMessages();
    case "protection_blocks": return getProtectionBlocksMessages();
    case "hours": return getHoursMessages();
    case "hours_posture": return getHoursPostureMessages();
    case "format": return getFormatMessages();
    case "simulation": return getSimulationMessages(ctx);
    case "simulation_walkthrough": return getSimulationWalkthroughMessages(ctx);
    case "complete": return getCompletionMessages(ctx);
    default: return getIntroMessages(ctx);
  }
}

async function loadSchedule(userId: string, timezone: string) {
  // Check if user has a Google account
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
    select: { id: true },
  });

  if (!account && process.env.NODE_ENV !== "production") {
    // Dev user without Google — use stub data
    return getStubSchedule(timezone);
  }

  try {
    return await getOrComputeSchedule(userId);
  } catch (e) {
    console.error("Failed to load schedule for onboarding:", e);
    // Fall back to stub in dev
    if (process.env.NODE_ENV !== "production") {
      return getStubSchedule(timezone);
    }
    return { slots: [], events: [], timezone, connected: false, canWrite: false, calendars: [] };
  }
}

async function savePhase(userId: string, phase: OnboardingPhase) {
  await prisma.user.update({
    where: { id: userId },
    data: { onboardingPhase: phase },
  });
}

async function completeOnboarding(userId: string, meetSlug: string) {
  // Set lastCalibratedAt
  await prisma.user.update({
    where: { id: userId },
    data: {
      lastCalibratedAt: new Date(),
      onboardingPhase: "complete",
    },
  });

  // Invalidate schedule so it recomputes with new preferences
  await invalidateSchedule(userId);

  // Seed a welcome message in the channel
  let channel = await prisma.channel.findUnique({ where: { userId } });
  if (!channel) {
    channel = await prisma.channel.create({ data: { userId } });
  }
  await prisma.channelMessage.create({
    data: {
      channelId: channel.id,
      role: "envoy",
      content: `Welcome back! Your Envoy is calibrated and ready. Tell me who you need to meet with, or share your link: agentenvoy.ai/meet/${meetSlug}`,
    },
  });
}
