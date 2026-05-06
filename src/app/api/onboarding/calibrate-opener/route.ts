/**
 * POST /api/onboarding/calibrate-opener
 *
 * Persists the seed-info Envoy ChannelMessage after a fresh-signup host
 * submits the calendar picker. The host then sees CalibrateChoicePanel:
 *   (a) "This is good enough to start" → theme question → done
 *   (b) "Customize my preferences" → POST /api/onboarding/calibrate-proceed
 *       writes the calibrate-opener message and starts the full arc
 *
 * Writes ONE message (seed-info only). The opener is written lazily by the
 * separate `calibrate-proceed` endpoint when the host picks path (b).
 *
 * Idempotency: if seed-info OR opener already exists, return the existing
 * row(s) without creating duplicates. Handles double-fire on slow networks
 * and page reloads.
 *
 * Back-compat: the response still includes an `opener` field (null if no
 * opener exists yet) so clients built against the old two-message contract
 * don't break during the rolling deploy window.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
      opener: existingOpener ?? null,
      message: existingOpener ?? existingSeedInfo,
    });
  }

  // Build seed-info text from the host's actual preferences.
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

  const seedInfo = await prisma.channelMessage.create({
    data: {
      channelId: channel.id,
      role: "envoy",
      content: seedInfoText,
      metadata: seedInfoMetadata,
    },
  });

  return NextResponse.json({
    seedInfo,
    opener: null,
    message: seedInfo,
  });
}
