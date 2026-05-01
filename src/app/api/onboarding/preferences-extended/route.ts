/**
 * POST /api/onboarding/preferences-extended
 *
 * Server route for the "fine-tune your availability + theme" continuation
 * flow. Same shape as `/api/onboarding/primary-link/route.ts` (SPEC §6.6
 * persist invariant + correctness-load-bearing resume from messages);
 * different step set + writers.
 *
 * Body shape:
 *   { start: true }              → kicks off (returns buffer prompt)
 *   { step, value, label }       → answers a step with a quick-reply pick
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { UserPreferences } from "@/lib/scoring";
import { invalidateSchedule } from "@/lib/calendar";
import {
  ExtendedStep,
  EXTENDED_STEP_ORDER,
  bufferPrompt,
  customRulesPrompt,
  eveningsPrompt,
  themePrompt,
  extendedCompletePrompt,
  nextExtendedStepAfter,
  customRuleTemplateToShape,
} from "./_steps";

const SUBKIND = "preferences-extended";

interface ExtCtx {
  userId: string;
  prefs: UserPreferences;
}

async function loadCtx(userId: string): Promise<ExtCtx | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user) return null;
  return {
    userId,
    prefs: (user.preferences as UserPreferences | null) ?? {},
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

async function appendStructuredRule(
  userId: string,
  ruleShape: ReturnType<typeof customRuleTemplateToShape>,
): Promise<void> {
  if (!ruleShape) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
  const prefs = (user?.preferences as UserPreferences | null) ?? {};
  const explicit = (prefs.explicit ?? {}) as Record<string, unknown>;
  const existing = (explicit.structuredRules as unknown[] | undefined) ?? [];
  const newRule = {
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...ruleShape,
    status: "active" as const,
    priority: 3,
    createdAt: new Date().toISOString(),
  };
  const nextExplicit = { ...explicit, structuredRules: [...existing, newRule] };
  const nextPrefs: UserPreferences = { ...prefs, explicit: nextExplicit as UserPreferences["explicit"] };
  await prisma.user.update({
    where: { id: userId },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });
}

async function logTuningUnsure(userId: string, step: ExtendedStep): Promise<void> {
  try {
    await prisma.onboardingEvent.create({
      data: { userId, kind: "tuning_unsure", entryPoint: `extended:${step}` },
    });
  } catch {
    // Non-fatal.
  }
}

async function persistStepTurns(
  userId: string,
  userLabel: string | null,
  envoyMessages: { content: string }[],
  step: ExtendedStep,
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
  for (let i = 0; i < envoyMessages.length; i++) {
    const m = envoyMessages[i];
    if (!m.content) continue;
    const isLast = i === envoyMessages.length - 1;
    const metadata: Record<string, unknown> = { kind: "onboarding", subkind: SUBKIND, step };
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

async function startResponse(ctx: ExtCtx): Promise<NextResponse> {
  const prompt = bufferPrompt();
  await persistStepTurns(ctx.userId, null, prompt.messages, "buffer");
  return NextResponse.json({
    step: prompt.step,
    messages: prompt.messages,
    complete: false,
  });
}

async function emitNextPrompt(
  ctx: ExtCtx,
  userLabel: string | null,
  fromStep: ExtendedStep,
): Promise<NextResponse> {
  const next = nextExtendedStepAfter(fromStep);
  if (next === "complete") {
    const prompt = extendedCompletePrompt();
    await persistStepTurns(ctx.userId, userLabel, prompt.messages, "complete");
    return NextResponse.json({
      step: "complete",
      messages: prompt.messages,
      complete: true,
    });
  }
  let prompt;
  if (next === "custom_rules") prompt = customRulesPrompt();
  else if (next === "evenings") prompt = eveningsPrompt();
  else if (next === "theme") prompt = themePrompt();
  else prompt = bufferPrompt();

  await persistStepTurns(ctx.userId, userLabel, prompt.messages, prompt.step);
  return NextResponse.json({
    step: prompt.step,
    messages: prompt.messages,
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

  const ctx = await loadCtx(userId);
  if (!ctx) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (body.start === true) {
    return await startResponse(ctx);
  }

  const step = typeof body.step === "string" ? (body.step as ExtendedStep) : null;
  const value = typeof body.value === "string" ? body.value : null;
  const label = typeof body.label === "string" ? body.label : null;

  if (!step || !EXTENDED_STEP_ORDER.includes(step)) {
    return NextResponse.json({ error: "Missing or invalid step" }, { status: 400 });
  }

  if (step === "buffer") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "buffer");
      return await emitNextPrompt(ctx, label, "buffer");
    }
    const buf = value ? parseInt(value, 10) : NaN;
    if (![0, 5, 10, 15, 30].includes(buf)) {
      return NextResponse.json({ error: "Invalid buffer value" }, { status: 400 });
    }
    await writeExplicit(userId, { bufferMinutes: buf });
    await invalidateSchedule(userId);
    return await emitNextPrompt(ctx, label, "buffer");
  }

  if (step === "custom_rules") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "custom_rules");
      return await emitNextPrompt(ctx, label, "custom_rules");
    }
    if (value === "__defer__") {
      // No structured rule written; user will use chat later. Acknowledge
      // by advancing.
      return await emitNextPrompt(ctx, label, "custom_rules");
    }
    const shape = value ? customRuleTemplateToShape(value) : null;
    if (!shape) {
      return NextResponse.json({ error: "Unknown rule template" }, { status: 400 });
    }
    await appendStructuredRule(userId, shape);
    await invalidateSchedule(userId);
    return await emitNextPrompt(ctx, label, "custom_rules");
  }

  if (step === "evenings") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "evenings");
      return await emitNextPrompt(ctx, label, "evenings");
    }
    if (value !== "protect" && value !== "flexible" && value !== "open") {
      return NextResponse.json({ error: "Invalid evenings value" }, { status: 400 });
    }
    await writeExplicit(userId, { eveningsPosture: value });
    return await emitNextPrompt(ctx, label, "evenings");
  }

  if (step === "theme") {
    if (value === "__unsure__") {
      await logTuningUnsure(userId, "theme");
      // Default: leave themeMode unset → existing read-side default applies.
      return await emitNextPrompt(ctx, label, "theme");
    }
    if (value !== "light" && value !== "dark" && value !== "auto") {
      return NextResponse.json({ error: "Invalid theme value" }, { status: 400 });
    }
    // themeMode lives in preferences.profile per /api/me/ui-prefs read-side.
    // We write directly via the same path the UI prefs route uses.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    const prefs = (user?.preferences as UserPreferences | null) ?? {};
    const profile =
      ((prefs as unknown as { profile?: Record<string, unknown> }).profile ?? {}) as Record<string, unknown>;
    const nextProfile = { ...profile, themeMode: value };
    const nextPrefs = {
      ...prefs,
      profile: nextProfile,
    } as unknown as UserPreferences;
    await prisma.user.update({
      where: { id: userId },
      data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
    });
    return await emitNextPrompt(ctx, label, "theme");
  }

  return NextResponse.json({ error: "Unhandled step" }, { status: 400 });
}
