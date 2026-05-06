/**
 * POST /api/onboarding/calibrate-opener
 *
 * Persists the deterministic recalibrate-first-time arc kickoff as TWO
 * Envoy `ChannelMessage`s after a fresh-signup host submits the calendar
 * picker. Replaces the PR-B synthetic-user-message hack which (a) classified
 * to the wrong intent and (b) bypassed the recalibrate first-time variant.
 *
 * **Hotfix-2 (2026-05-05): two-message contract.** John's verbatim flow:
 * *"After clicking the calendar picker, the user enters a clear chat window.
 * The first message has their Google seed information. It then asks the user
 * to describe their calendar."* Previously the four Google-seed bullets were
 * a React widget (`<PostureBubble>`) inside `<FirstRunWelcome>` — they
 * disappeared the moment a real ChannelMessage landed (welcome unmounted on
 * `hasRealChat`). Now the bullets are the FIRST persisted Envoy message in
 * the channel, surviving reload and surviving the welcome unmount.
 *
 * Atomic write: BOTH messages persist on the first invocation.
 *   1. `subkind: "calibrate-seed-info"` — the four Google-seed bullets in
 *      first-person Envoy voice.
 *   2. `subkind: "calibrate-opener"` — the warm anchor opener that asks the
 *      host to describe their calendar.
 *
 * Idempotency widens to either subkind: if EITHER message already exists in
 * the host's channel, return the existing pair without creating duplicates.
 * Picker submit can fire twice on slow networks; reload should auto-resume
 * on the existing pair.
 *
 * The next host turn is force-routed to `recalibrate.first-time` by the
 * dispatch override in `app/api/channel/chat/route.ts` (which keys off
 * `metadata.subkind === "calibrate-opener"` on the latest envoy turn within a
 * 30-minute window).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CALIBRATE_FIRST_TIME_OPENER_TEXT } from "@/lib/onboarding/calibrate-opener-text";
import { buildCalibrateSeedInfoText } from "@/lib/onboarding/calibrate-seed-info-text";
import type { UserPreferences } from "@/lib/scoring";
import { DEFAULT_TIMEZONE } from "@/lib/timezone";

const SEED_INFO_SUBKIND = "calibrate-seed-info";
const OPENER_SUBKIND = "calibrate-opener";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, preferences: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Get or create the host's channel.
  let channel = await prisma.channel.findUnique({ where: { userId: user.id } });
  if (!channel) {
    channel = await prisma.channel.create({ data: { userId: user.id } });
  }

  // Idempotency: if EITHER message already exists, return the existing pair
  // without creating duplicates. Picker submit can double-fire on slow
  // networks; reload should auto-resume on the existing pair.
  const [existingSeedInfo, existingOpener] = await Promise.all([
    prisma.channelMessage.findFirst({
      where: {
        channelId: channel.id,
        role: "envoy",
        metadata: { path: ["subkind"], equals: SEED_INFO_SUBKIND },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.channelMessage.findFirst({
      where: {
        channelId: channel.id,
        role: "envoy",
        metadata: { path: ["subkind"], equals: OPENER_SUBKIND },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (existingSeedInfo || existingOpener) {
    return NextResponse.json({
      seedInfo: existingSeedInfo,
      opener: existingOpener,
      // Back-compat for any client still reading `.message` (the old
      // single-message shape); points at the opener.
      message: existingOpener ?? existingSeedInfo,
    });
  }

  // Build seed-info text from the host's actual preferences. Mirrors the
  // resolution logic in /api/me/scheduling-defaults GET (which the
  // <PostureBubble> reads from).
  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const e = prefs.explicit ?? {};
  const bhs = e.businessHoursStart ?? 9;
  const bhe = e.businessHoursEnd ?? 17;
  const bhsMin = e.businessHoursStartMinutes ?? bhs * 60;
  const bheMin = e.businessHoursEndMinutes ?? bhe * 60;
  const tz = (e as { timezone?: string }).timezone ?? DEFAULT_TIMEZONE;
  const videoProvider =
    (e as { videoProvider?: string }).videoProvider ?? "google_meet";
  const defaultDuration = e.defaultDuration ?? 30;

  const seedInfoText = buildCalibrateSeedInfoText({
    businessHoursStartMinutes: bhsMin,
    businessHoursEndMinutes: bheMin,
    defaultDuration,
    videoProvider,
    timezone: tz,
  });

  const seedInfoMetadata: Prisma.InputJsonValue = {
    kind: "onboarding",
    subkind: SEED_INFO_SUBKIND,
    playbookVariant: "first-time",
  };
  const openerMetadata: Prisma.InputJsonValue = {
    kind: "onboarding",
    subkind: OPENER_SUBKIND,
    playbookVariant: "first-time",
  };

  // Order contract: seed-info FIRST (earlier createdAt), opener SECOND (later
  // createdAt). The bundle renders chronologically, so seed-info appears
  // above the opener in the feed — matching John's verbatim flow ("the first
  // message has their Google seed information").
  //
  // HOTFIX-3 (2026-05-05): we previously used `prisma.$transaction([...])`
  // which assigns Postgres `now()` to both rows. Inside a single transaction
  // `now()` returns the transaction-start time, so both rows got IDENTICAL
  // `createdAt` timestamps and feed ordering became non-deterministic
  // (often resolved by id, putting opener first — exactly the regression).
  // Fix: explicit JS-computed timestamps with seed-info < opener (1ms gap),
  // passed via `data.createdAt` to override the schema default. Keeps the
  // single-transaction atomicity guarantee.
  const seedInfoCreatedAt = new Date();
  const openerCreatedAt = new Date(seedInfoCreatedAt.getTime() + 1);
  const [seedInfo, opener] = await prisma.$transaction([
    prisma.channelMessage.create({
      data: {
        channelId: channel.id,
        role: "envoy",
        content: seedInfoText,
        metadata: seedInfoMetadata,
        createdAt: seedInfoCreatedAt,
      },
    }),
    prisma.channelMessage.create({
      data: {
        channelId: channel.id,
        role: "envoy",
        content: CALIBRATE_FIRST_TIME_OPENER_TEXT,
        metadata: openerMetadata,
        createdAt: openerCreatedAt,
      },
    }),
  ]);

  return NextResponse.json({
    seedInfo,
    opener,
    // Back-compat for any client still reading `.message`.
    message: opener,
  });
}
