import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Dev-only endpoint for onboarding testing.
 * POST /api/debug/onboarding-reset
 *
 * mode: "reset" — reset current user's onboarding state
 * mode: "create" — create a throwaway test account
 */
export async function POST(req: NextRequest) {
  // Guard: dev only
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { mode } = body as { mode: "reset" | "create" | "calibrate" };

  // Mark user as calibrated (skip onboarding) — used by dev-login
  if (mode === "calibrate") {
    await prisma.user.update({
      where: { email: session.user.email },
      data: { lastCalibratedAt: new Date() },
    });
    return NextResponse.json({ success: true, message: "User marked as calibrated." });
  }

  if (mode === "reset") {
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true, preferences: true },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Keep timezone from preferences, clear everything else
    const prefs = (user.preferences as Record<string, unknown>) || {};
    const explicit = (prefs.explicit as Record<string, unknown>) || {};
    const timezone = explicit.timezone || "America/Los_Angeles";

    // Clear calibration + onboarding state
    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastCalibratedAt: null,
        onboardingPhase: null,
        persistentKnowledge: [
          "- This host has not been calibrated yet. Run the onboarding calibration exercise to learn their scheduling preferences.",
          "- Default posture: balanced — offer open slots, flag flexible blocks, ask before moving anything.",
          "- Default to 30-minute meetings unless context suggests otherwise.",
          "- Prefer consolidating meetings on fewer days over spreading them out.",
        ].join("\n"),
        upcomingSchedulePreferences: null,
        preferences: { explicit: { timezone } },
      },
    });

    // Clear calendar cache
    await prisma.calendarCache.deleteMany({ where: { userId: user.id } });

    // Clear computed schedule (uses any cast per project pattern)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).computedSchedule.deleteMany({ where: { userId: user.id } });

    // Clear channel messages + sessions
    const channel = await prisma.channel.findUnique({ where: { userId: user.id } });
    if (channel) {
      await prisma.channelMessage.deleteMany({ where: { channelId: channel.id } });
      await prisma.channelSession.deleteMany({ where: { channelId: channel.id } });
    }

    return NextResponse.json({ success: true, message: "Onboarding reset. Reload to enter /onboarding." });
  }

  if (mode === "create") {
    const timestamp = Date.now();
    const email = `onboarding-test-${timestamp}@agentenvoy.dev`;
    const name = `Test User ${timestamp}`;
    const slug = `test${timestamp}`;

    const user = await prisma.user.create({
      data: {
        email,
        name,
        meetSlug: slug,
        preferences: { explicit: { timezone: "America/Los_Angeles" } },
        persistentKnowledge: [
          "- This host has not been calibrated yet.",
          "- Default posture: balanced.",
        ].join("\n"),
      },
    });

    return NextResponse.json({
      success: true,
      email,
      name,
      userId: user.id,
      meetSlug: slug,
      message: `Test account created. Sign in with dev credentials using email: ${email}`,
    });
  }

  return NextResponse.json({ error: "Invalid mode. Use 'reset' or 'create'." }, { status: 400 });
}
