/**
 * POST /api/onboarding/calibrate-opener
 *
 * Persists the deterministic warm-anchor opener as an Envoy `ChannelMessage`
 * after a fresh-signup host submits the calendar picker. Replaces the PR-B
 * synthetic-user-message hack which (a) classified to the wrong intent and
 * (b) bypassed the recalibrate first-time variant.
 *
 * Flow contract (John verbatim, decided proposal 2026-05-05):
 *   picker submit → calendar bullets → reasoning bubble → THIS opener bubble
 *   → host types their week → composer extracts rules + preferences.
 *
 * No LLM call here — the opener text is a constant
 * (`CALIBRATE_FIRST_TIME_OPENER_TEXT`). The next host turn is force-routed to
 * `recalibrate.first-time` by the dispatch override in
 * `app/api/channel/chat/route.ts` (which keys off `metadata.subkind ===
 * "calibrate-opener"` on the latest envoy turn within a 30-minute window).
 *
 * Idempotency: if a `subkind: "calibrate-opener"` message already exists in
 * the host's channel, return that one instead of creating a duplicate.
 * Picker submit can fire twice on slow networks; we don't want two opener
 * bubbles, and reload should auto-resume on the existing one.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CALIBRATE_FIRST_TIME_OPENER_TEXT } from "@/lib/onboarding/calibrate-opener-text";

const SUBKIND = "calibrate-opener";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Get or create the host's channel.
  let channel = await prisma.channel.findUnique({ where: { userId: user.id } });
  if (!channel) {
    channel = await prisma.channel.create({ data: { userId: user.id } });
  }

  // Idempotency: if an opener already exists, return it.
  // Filtering by JSON path on Postgres via Prisma's JsonFilter:
  const existing = await prisma.channelMessage.findFirst({
    where: {
      channelId: channel.id,
      role: "envoy",
      metadata: {
        path: ["subkind"],
        equals: SUBKIND,
      },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return NextResponse.json({ message: existing });
  }

  const metadata: Prisma.InputJsonValue = {
    kind: "onboarding",
    subkind: SUBKIND,
    playbookVariant: "first-time",
  };

  const message = await prisma.channelMessage.create({
    data: {
      channelId: channel.id,
      role: "envoy",
      content: CALIBRATE_FIRST_TIME_OPENER_TEXT,
      metadata,
    },
  });

  return NextResponse.json({ message });
}
