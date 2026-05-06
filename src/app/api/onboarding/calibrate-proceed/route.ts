/**
 * POST /api/onboarding/calibrate-proceed
 *
 * Called when the host picks path (b) — "Customize my preferences" — from
 * CalibrateChoicePanel. Writes the calibrate-opener ChannelMessage so the
 * dispatch override in `app/api/channel/chat/route.ts` can detect it and
 * force-route the next host turn to `recalibrate.first-time`.
 *
 * Idempotency: if the opener already exists, return it without creating a
 * duplicate. Double-click on the chip is harmless.
 *
 * Order contract: seed-info was written by `/api/onboarding/calibrate-opener`
 * at an earlier timestamp. We set the opener's `createdAt` to now, which is
 * always after seed-info, preserving chronological feed order.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CALIBRATE_FIRST_TIME_OPENER_TEXT } from "@/lib/onboarding/calibrate-opener-text";

const OPENER_SUBKIND = "calibrate-opener";

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

  const channel = await prisma.channel.findUnique({ where: { userId: user.id } });
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  // Idempotency: return existing opener if already written.
  const existing = await prisma.channelMessage.findFirst({
    where: {
      channelId: channel.id,
      role: "envoy",
      metadata: { path: ["subkind"], equals: OPENER_SUBKIND },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return NextResponse.json({ opener: existing });
  }

  const openerMetadata: Prisma.InputJsonValue = {
    kind: "onboarding",
    subkind: OPENER_SUBKIND,
    playbookVariant: "first-time",
  };

  const opener = await prisma.channelMessage.create({
    data: {
      channelId: channel.id,
      role: "envoy",
      content: CALIBRATE_FIRST_TIME_OPENER_TEXT,
      metadata: openerMetadata,
    },
  });

  return NextResponse.json({ opener });
}
