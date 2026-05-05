/**
 * POST /api/onboarding/primary-link
 *
 * Server route for the primary-link tuning conversational flow. Mirrors
 * the legacy `/api/onboarding/chat` shape: each call advances one step,
 * persists the user's message + the Envoy response as `ChannelMessage`
 * rows tagged `metadata: { kind: "onboarding", subkind: "primary-link-tuning",
 * step: <step> }`, and applies the side-effect write (preferences /
 * primary-link-settings).
 *
 * Resume model: current step is inferred from the channel's most recent
 * tuning message (option (b) per proposal `2026-04-30_onboarding-and-tuning-as-chat`
 * §2.3). No `User.primaryLinkTuningStep` column. The persisted message
 * stream is correctness-load-bearing for state-machine resume — see
 * SPEC §6.6.
 *
 * Body shape:
 *   { start: true }                    — kicks off (returns timezone prompt)
 *   { step, value, label }              — answers a step with a quick-reply pick
 *   { step, freetext: <string> }        — answers timezone-other or hours-custom
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { UserPreferences } from "@/lib/scoring";
import { invalidateSchedule } from "@/lib/calendar";
import { parseBusinessHoursRange } from "@/lib/time-parse";
import {
  PrimaryLinkStep,
  timezonePrompt,
  timezoneOtherPrompt,
  hoursPrompt,
  hoursCustomPrompt,
  durationPrompt,
  formatPrompt,
  zoomLinkPrompt,
  phoneNumberPrompt,
  guestFlexPrompt,
  completePrompt,
  parseHoursValue,
  formatMinutes,
  nextStepAfter,
} from "./_steps";

const SUBKIND = "primary-link-tuning";

type FormatValue = "video" | "phone" | "in-person";

interface TuningCtx {
  userId: string;
  browserTz: string | null;
  prefs: UserPreferences;
  meetSlug: string | null;
}

async function loadCtx(userId: string, browserTz: string | null): Promise<TuningCtx | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true, meetSlug: true },
  });
  if (!user) return null;
  return {
    userId,
    browserTz,
    prefs: (user.preferences as UserPreferences | null) ?? {},
    meetSlug: user.meetSlug ?? null,
  };
}

async function writeExplicit(userId: string, patch: Record<string, unknown>): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
  const prefs = (user?.preferences as UserPreferences | null) ?? {};
  const nextExplicit = { ...(prefs.explicit ?? {}), ...patch };
  const nextPrefs: UserPreferences = { ...prefs, explicit: nextExplicit };
  await prisma.user.update({
    where: { id: userId },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });
}

async function writeGuestPicks(userId: string, picks: { format: boolean; duration: boolean }): Promise<void> {
  await writeExplicit(userId, { primaryLinkGuestPicks: picks });
}

async function logTuningUnsure(userId: string, step: PrimaryLinkStep): Promise<void> {
  try {
    await prisma.onboardingEvent.create({
      data: { userId, kind: "tuning_unsure", entryPoint: step },
    });
  } catch {
    // Non-fatal — telemetry doesn't gate the flow.
  }
}

/**
 * Persist user + envoy turns for one advance, tagging metadata with the
 * step that produced them so resume-state inference (option (b)) can read
 * the latest tuning message and identify the most recent prompt.
 */
async function persistStepTurns(
  userId: string,
  userLabel: string | null,
  envoyMessages: { content: string }[],
  step: PrimaryLinkStep,
  freetextHint?: "timezone-other" | "hours-custom" | "zoom-link" | "phone-number",
): Promise<void> {
  let channel = await prisma.channel.findUnique({ where: { userId } });
  if (!channel) channel = await prisma.channel.create({ data: { userId } });
  if (userLabel) {
    await prisma.channelMessage.create({
      data: {
        channelId: channel.id,
        role: "user",
        content: userLabel,
        metadata: { kind: "onboarding", subkind: SUBKIND, step },
      },
    });
  }
  // Tag the last envoy message with freetextHint (if any) — the client
  // reads only the *latest* tuning message's metadata to decide whether to
  // render quick-reply options or a freetext input.
  for (let i = 0; i < envoyMessages.length; i++) {
    const m = envoyMessages[i];
    if (!m.content) continue;
    const isLast = i === envoyMessages.length - 1;
    const metadata: Record<string, unknown> = { kind: "onboarding", subkind: SUBKIND, step };
    if (isLast && freetextHint) metadata.freetextHint = freetextHint;
    if (isLast && step === "complete") metadata.terminal = true;
    await prisma.channelMessage.create({
      data: {
        channelId: channel.id,
        role: "envoy",
        content: m.content,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

async function buildSummaryMessage(ctx: TuningCtx): Promise<string> {
  const e = ctx.prefs.explicit ?? {};
  const start = (e as { businessHoursStartMinutes?: number }).businessHoursStartMinutes ?? 540;
  const end = (e as { businessHoursEndMinutes?: number }).businessHoursEndMinutes ?? 1020;
  const dur = (e as { defaultDuration?: number }).defaultDuration ?? 30;
  const fmt = ((e as { defaultFormat?: string }).defaultFormat ?? "video") as FormatValue;
  const picks = ((e as { primaryLinkGuestPicks?: { format: boolean; duration: boolean } }).primaryLinkGuestPicks) ?? { format: false, duration: false };
  const linkText = ctx.meetSlug ? ` Here's your primary link: \`agentenvoy.ai/meet/${ctx.meetSlug}\`.` : "";
  const flexText =
    picks.format && picks.duration
      ? ", and guests can adjust format or duration"
      : picks.format
        ? ", and guests can pick a different format"
        : picks.duration
          ? ", and guests can ask for a longer or shorter slot"
          : "";
  return `All set!${linkText} I'll offer times **${formatMinutes(start)}–${formatMinutes(end)}**, default to **${dur}-minute** **${fmt}** meetings${flexText}. You can tweak any of this later — just tell me in chat.`;
}

function shortFormat(fmt: FormatValue): string {
  return fmt === "video" ? "VC" : fmt === "phone" ? "phone call" : "in-person";
}

/** Google-seeded prefs.timezone wins; browser tz is the fallback. */
function proposedTz(ctx: TuningCtx): string | null {
  return (ctx.prefs.timezone as string | undefined) ?? ctx.browserTz;
}

async function startResponse(ctx: TuningCtx): Promise<NextResponse> {
  const prompt = timezonePrompt(proposedTz(ctx));
  await persistStepTurns(ctx.userId, null, prompt.messages, "timezone", prompt.freetextHint);
  return NextResponse.json({
    step: prompt.step,
    messages: prompt.messages,
    freetextHint: prompt.freetextHint,
    complete: false,
  });
}

async function emitNextPrompt(
  ctx: TuningCtx,
  userLabel: string | null,
  fromStep: PrimaryLinkStep,
  /** When set, override the linear STEP_ORDER successor — used by `format`
   *  to insert the conditional sub-steps `zoom_link` / `phone_number`
   *  before `guest_flex`. */
  overrideNext?: PrimaryLinkStep,
): Promise<NextResponse> {
  const next = overrideNext ?? nextStepAfter(fromStep);
  if (next === "complete") {
    const summary = await buildSummaryMessage(ctx);
    const prompt = completePrompt(summary);
    await persistStepTurns(ctx.userId, userLabel, prompt.messages, "complete", undefined);
    return NextResponse.json({
      step: "complete",
      messages: prompt.messages,
      complete: true,
    });
  }

  let prompt;
  if (next === "hours") prompt = hoursPrompt();
  else if (next === "duration") prompt = durationPrompt();
  else if (next === "format") prompt = formatPrompt();
  else if (next === "zoom_link") prompt = zoomLinkPrompt();
  else if (next === "phone_number") prompt = phoneNumberPrompt();
  else if (next === "guest_flex") {
    const e = ctx.prefs.explicit ?? {};
    const dur = (e as { defaultDuration?: number }).defaultDuration ?? 30;
    const fmt = ((e as { defaultFormat?: string }).defaultFormat ?? "video") as FormatValue;
    prompt = guestFlexPrompt(`${dur}m`, shortFormat(fmt));
  } else {
    // Shouldn't reach here under STEP_ORDER, but be defensive.
    prompt = timezonePrompt(proposedTz(ctx));
  }

  await persistStepTurns(ctx.userId, userLabel, prompt.messages, prompt.step, prompt.freetextHint);
  return NextResponse.json({
    step: prompt.step,
    messages: prompt.messages,
    freetextHint: prompt.freetextHint,
    complete: false,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const browserTz = typeof body.browserTz === "string" ? body.browserTz : null;
  const ctx = await loadCtx(userId, browserTz);
  if (!ctx) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Initial kick-off
  if (body.start === true) {
    return await startResponse(ctx);
  }

  const step = typeof body.step === "string" ? (body.step as PrimaryLinkStep) : null;
  const value = typeof body.value === "string" ? body.value : null;
  const label = typeof body.label === "string" ? body.label : null;
  const freetext = typeof body.freetext === "string" ? body.freetext : null;

  // Validate against the full step union — STEP_ORDER is just the spine
  // (always-present steps); zoom_link / phone_number are conditional
  // sub-steps inserted by the route after `format` based on the user's
  // pick. Validating against STEP_ORDER alone rejected those legitimate
  // requests with "Missing or invalid step."
  const VALID_STEPS: ReadonlySet<PrimaryLinkStep> = new Set([
    "timezone",
    "hours",
    "duration",
    "format",
    "zoom_link",
    "phone_number",
    "guest_flex",
    "complete",
  ]);
  if (!step || !VALID_STEPS.has(step)) {
    return NextResponse.json({ error: "Missing or invalid step" }, { status: 400 });
  }

  // ── Step dispatchers ────────────────────────────────────────────────

  if (step === "timezone") {
    // Non-skippable — reject __unsure__.
    if (value === "__unsure__") {
      return NextResponse.json(
        { error: "Timezone is required — please pick one to continue." },
        { status: 400 },
      );
    }
    if (value === "__other__") {
      const prompt = timezoneOtherPrompt();
      await persistStepTurns(ctx.userId, label, prompt.messages, "timezone", prompt.freetextHint);
      return NextResponse.json({
        step: "timezone",
        messages: prompt.messages,
        freetextHint: prompt.freetextHint,
        complete: false,
      });
    }
    const tz = (freetext ?? value)?.trim();
    if (!tz) {
      return NextResponse.json({ error: "Timezone required" }, { status: 400 });
    }
    await writeExplicit(userId, { timezone: tz, timezoneSource: "user-confirmed" });
    ctx.prefs = { ...ctx.prefs, explicit: { ...(ctx.prefs.explicit ?? {}), timezone: tz, timezoneSource: "user-confirmed" } as UserPreferences["explicit"] };
    return await emitNextPrompt(ctx, label ?? tz, "timezone");
  }

  if (step === "hours") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "hours");
      return await emitNextPrompt(ctx, label, "hours");
    }
    if (value === "__custom__") {
      const prompt = hoursCustomPrompt();
      await persistStepTurns(ctx.userId, label, prompt.messages, "hours", prompt.freetextHint);
      return NextResponse.json({
        step: "hours",
        messages: prompt.messages,
        freetextHint: prompt.freetextHint,
        complete: false,
      });
    }
    let startMin: number, endMin: number, persistedLabel: string;
    if (freetext) {
      const parsed = parseBusinessHoursRange(freetext);
      if (!parsed) {
        return NextResponse.json(
          {
            error: 'Couldn\'t parse hours. Try "8:30 to 5:30" or "9am-6pm". Times must be on the half hour.',
          },
          { status: 400 },
        );
      }
      startMin = parsed.startMinutes;
      endMin = parsed.endMinutes;
      persistedLabel = `${formatMinutes(startMin)} – ${formatMinutes(endMin)}`;
    } else {
      const parsed = value ? parseHoursValue(value) : null;
      if (!parsed) return NextResponse.json({ error: "Invalid hours value" }, { status: 400 });
      startMin = parsed.startMinutes;
      endMin = parsed.endMinutes;
      persistedLabel = label ?? `${formatMinutes(startMin)} – ${formatMinutes(endMin)}`;
    }
    await writeExplicit(userId, {
      businessHoursStart: Math.floor(startMin / 60),
      businessHoursEnd: Math.floor(endMin / 60),
      businessHoursStartMinutes: startMin,
      businessHoursEndMinutes: endMin,
    });
    await invalidateSchedule(userId);
    ctx.prefs = {
      ...ctx.prefs,
      explicit: {
        ...(ctx.prefs.explicit ?? {}),
        businessHoursStartMinutes: startMin,
        businessHoursEndMinutes: endMin,
      } as UserPreferences["explicit"],
    };
    return await emitNextPrompt(ctx, persistedLabel, "hours");
  }

  if (step === "duration") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "duration");
      return await emitNextPrompt(ctx, label, "duration");
    }
    const dur = value ? parseInt(value, 10) : NaN;
    if (![15, 30, 45, 60, 90].includes(dur)) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }
    await writeExplicit(userId, { defaultDuration: dur, bufferMinutes: 0 });
    ctx.prefs = {
      ...ctx.prefs,
      explicit: { ...(ctx.prefs.explicit ?? {}), defaultDuration: dur, bufferMinutes: 0 } as UserPreferences["explicit"],
    };
    return await emitNextPrompt(ctx, label, "duration");
  }

  if (step === "format") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "format");
      return await emitNextPrompt(ctx, label, "format");
    }
    // The UI surfaces `google_meet | zoom | phone | in-person`, but the
    // persisted shape is `defaultFormat: video|phone|in-person` plus
    // `videoProvider: google_meet|zoom`. Map the UI value to both. After
    // the write, hop to the conditional sub-step that collects the
    // credential the chosen format needs (zoom-link / phone-number),
    // skipping it for Meet + in-person which need nothing further.
    let defaultFormat: FormatValue;
    let videoProvider: string | undefined;
    let nextStep: PrimaryLinkStep = "guest_flex";
    if (value === "google_meet") {
      defaultFormat = "video";
      videoProvider = "google_meet";
    } else if (value === "zoom") {
      defaultFormat = "video";
      videoProvider = "zoom";
      nextStep = "zoom_link";
    } else if (value === "phone") {
      defaultFormat = "phone";
      nextStep = "phone_number";
    } else if (value === "in-person") {
      defaultFormat = "in-person";
    } else {
      return NextResponse.json({ error: "Invalid format" }, { status: 400 });
    }
    const patch: Record<string, unknown> = { defaultFormat };
    if (videoProvider) patch.videoProvider = videoProvider;
    await writeExplicit(userId, patch);
    ctx.prefs = {
      ...ctx.prefs,
      explicit: { ...(ctx.prefs.explicit ?? {}), ...patch } as UserPreferences["explicit"],
    };
    return await emitNextPrompt(ctx, label, "format", nextStep);
  }

  if (step === "zoom_link") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "zoom_link");
      return await emitNextPrompt(ctx, label, "zoom_link", "guest_flex");
    }
    const link = (freetext ?? value)?.trim();
    if (!link) {
      return NextResponse.json({ error: "Zoom link required" }, { status: 400 });
    }
    // Light validation — must look URL-ish; we don't constrain to zoom.us
    // because some hosts use vanity domains (zoom.example.com).
    if (!/^https?:\/\//i.test(link) && !link.includes(".")) {
      return NextResponse.json(
        { error: "That doesn't look like a meeting URL — try the full https://… link." },
        { status: 400 },
      );
    }
    await writeExplicit(userId, { zoomLink: link });
    ctx.prefs = {
      ...ctx.prefs,
      explicit: { ...(ctx.prefs.explicit ?? {}), zoomLink: link } as UserPreferences["explicit"],
    };
    return await emitNextPrompt(ctx, label ?? link, "zoom_link", "guest_flex");
  }

  if (step === "phone_number") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "phone_number");
      return await emitNextPrompt(ctx, label, "phone_number", "guest_flex");
    }
    const phone = (freetext ?? value)?.trim();
    if (!phone) {
      return NextResponse.json({ error: "Phone number required" }, { status: 400 });
    }
    if (phone.replace(/[^\d]/g, "").length < 7) {
      return NextResponse.json(
        { error: "That doesn't look like a phone number — try a full number like +1 555-1234." },
        { status: 400 },
      );
    }
    await writeExplicit(userId, { phone });
    ctx.prefs = {
      ...ctx.prefs,
      explicit: { ...(ctx.prefs.explicit ?? {}), phone } as UserPreferences["explicit"],
    };
    return await emitNextPrompt(ctx, label ?? phone, "phone_number", "guest_flex");
  }

  if (step === "guest_flex") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "guest_flex");
      // Default to locked (matches existing per-link default).
      await writeGuestPicks(userId, { format: false, duration: false });
      ctx.prefs = {
        ...ctx.prefs,
        explicit: {
          ...(ctx.prefs.explicit ?? {}),
          primaryLinkGuestPicks: { format: false, duration: false },
        } as UserPreferences["explicit"],
      };
      return await emitNextPrompt(ctx, label, "guest_flex");
    }
    let picks: { format: boolean; duration: boolean };
    if (value === "locked" || value === "vip_only") {
      picks = { format: false, duration: false };
    } else if (value === "format") {
      picks = { format: true, duration: false };
    } else if (value === "duration") {
      picks = { format: false, duration: true };
    } else if (value === "both") {
      picks = { format: true, duration: true };
    } else {
      return NextResponse.json({ error: "Invalid guest_flex value" }, { status: 400 });
    }
    await writeGuestPicks(userId, picks);
    ctx.prefs = {
      ...ctx.prefs,
      explicit: { ...(ctx.prefs.explicit ?? {}), primaryLinkGuestPicks: picks } as UserPreferences["explicit"],
    };
    return await emitNextPrompt(ctx, label, "guest_flex");
  }

  return NextResponse.json({ error: "Unhandled step" }, { status: 400 });
}
