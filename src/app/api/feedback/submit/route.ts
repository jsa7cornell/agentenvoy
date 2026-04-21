/**
 * POST /api/feedback/submit — user-triggered feedback bundle (F3).
 *
 * Auth: NextAuth session required. CSRF: same-origin only.
 * Payload validated by FeedbackSubmitSchema. Server reads from its own DB
 * keyed on session.user.id — never trusts client-provided content.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { FeedbackSubmitSchema } from "@/lib/feedback/schema";
import { buildFeedbackBundle } from "@/lib/feedback/bundle-builder";
import { track } from "@/lib/analytics/track";

export const dynamic = "force-dynamic";

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
    const appUrl = process.env.NEXTAUTH_URL;
    if (appUrl) {
      const appHost = new URL(appUrl).hostname;
      if (url.hostname === appHost) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ ok: false, error: "Invalid origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const parsed = FeedbackSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid submission", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const submission = parsed.data;

  let bundle;
  try {
    bundle = await buildFeedbackBundle({
      userId,
      submission,
      appVersion: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
    });
  } catch (err) {
    console.error("[feedback.submit] bundle build failed", { userId, err });
    return NextResponse.json(
      { ok: false, error: "Could not build feedback bundle" },
      { status: 500 },
    );
  }

  let report;
  try {
    report = await prisma.feedbackReport.create({
      data: {
        userId,
        sessionId: submission.sessionId ?? null,
        userText: submission.userText,
        triedToDoText: submission.triedToDoText ?? null,
        userAgent: submission.userAgent ?? null,
        url: submission.url ?? null,
        checklistState: submission.checklistState as never,
        bundle: bundle as never,
      },
      select: { id: true },
    });
  } catch (err) {
    console.error("[feedback.submit] insert failed", { userId, err });
    return NextResponse.json(
      { ok: false, error: "Could not save feedback" },
      { status: 500 },
    );
  }

  await track({
    name: "feedback.report_submitted",
    userId,
    sessionId: submission.sessionId ?? null,
    props: {
      messages: submission.checklistState.messages,
      sessions: submission.checklistState.sessions,
      calendar: submission.checklistState.calendar,
      errors: submission.checklistState.errors,
      console: submission.checklistState.console,
      hasTriedToDoText: Boolean(submission.triedToDoText),
    },
  });

  return NextResponse.json({ ok: true, reportId: report.id });
}
