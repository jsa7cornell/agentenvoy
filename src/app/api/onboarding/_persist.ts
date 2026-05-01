import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { PhaseResult } from "@/lib/onboarding-machine";

/**
 * Persist one onboarding turn as a `ChannelMessage` so history survives
 * page reload and reviewing past settings decisions is possible.
 *
 * Metadata always tags `kind: "onboarding"`. An optional `subkind` (e.g.
 * `"primary-link-tuning"`) disambiguates which scaffolded flow produced
 * the turn — see SPEC §6.6 "Subkind metadata convention." Legacy callers
 * (the `/api/onboarding/chat` machine) pass no subkind; the field is
 * omitted from metadata in that case so existing rows remain unchanged.
 */
export async function persistOnboardingTurn(
  userId: string,
  role: "user" | "envoy",
  content: string,
  subkind?: string,
) {
  let channel = await prisma.channel.findUnique({ where: { userId } });
  if (!channel) channel = await prisma.channel.create({ data: { userId } });
  const metadata: Record<string, string> = { kind: "onboarding" };
  if (subkind) metadata.subkind = subkind;
  await prisma.channelMessage.create({
    data: {
      channelId: channel.id,
      role,
      content,
      metadata,
    },
  });
}

/**
 * Shared exit point for onboarding handlers: persist the envoy messages
 * we're about to return, then emit the JSON response. The user's prior
 * turn is expected to have been persisted at the top of POST.
 *
 * `subkind` is forwarded to each persisted Envoy bubble so step-driven
 * flows (primary-link tuning, future deal-room intake) tag their messages
 * for later filtering and resume-state inference.
 */
export async function respondWithPersist(
  userId: string,
  result: PhaseResult,
  extras: Record<string, unknown> = {},
  subkind?: string,
) {
  for (const m of result.messages) {
    if (m.content) await persistOnboardingTurn(userId, "envoy", m.content, subkind);
  }
  return NextResponse.json({ ...result, ...extras });
}
