import { prisma } from "@/lib/prisma";

/**
 * OnboardingEvent emitters. See proposal
 * `2026-04-21_lean-first-run-onboarding-and-returnto_*.md` §2.5.
 *
 * Two event kinds for v1: `entered` and `completed`. PII-free by design
 * (no freetext, no metadata blob) so the stream is safe to query without
 * redaction. Goal-level events defer to a later PR.
 *
 * De-dup: `emitOnboardingEntered` is no-op when the same user already has
 * an `entered` row in the last 24h. Dashboard reloads don't double-count.
 */

const ENTERED_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function emitOnboardingEntered(opts: {
  userId: string;
  entryPoint: string | null;
  hasReturnTo: boolean;
}): Promise<void> {
  try {
    const since = new Date(Date.now() - ENTERED_DEDUP_WINDOW_MS);
    const existing = await prisma.onboardingEvent.findFirst({
      where: { userId: opts.userId, kind: "entered", at: { gte: since } },
      select: { id: true },
    });
    if (existing) return;
    await prisma.onboardingEvent.create({
      data: {
        userId: opts.userId,
        kind: "entered",
        entryPoint: opts.entryPoint ?? null,
        hasReturnTo: opts.hasReturnTo,
      },
    });
  } catch (e) {
    console.error("[onboarding.events] emitEntered failed:", e);
  }
}

export async function emitOnboardingCompleted(opts: {
  userId: string;
}): Promise<void> {
  try {
    await prisma.onboardingEvent.create({
      data: { userId: opts.userId, kind: "completed" },
    });
  } catch (e) {
    console.error("[onboarding.events] emitCompleted failed:", e);
  }
}
