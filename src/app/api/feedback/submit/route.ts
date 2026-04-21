/**
 * POST /api/feedback/submit — user-triggered feedback bundle (F3).
 *
 * Auth: NextAuth session required. CSRF: same-origin only.
 * Payload validated by FeedbackSubmitSchema. Server reads from its own DB
 * keyed on session.user.id — never trusts client-provided content.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { randomBytes } from "crypto";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { FeedbackSubmitSchema } from "@/lib/feedback/schema";
import { buildFeedbackBundle } from "@/lib/feedback/bundle-builder";
import { track } from "@/lib/analytics/track";
import { isAdminSession } from "@/lib/admin-auth";
import { signAgentToken } from "@/lib/feedback/agent-token";
import { logAdminAccess } from "@/lib/admin/access-log";

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
  const errorRef = randomBytes(6).toString("hex");

  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json(
      { ok: false, error: "Invalid origin", errorRef },
      { status: 403 },
    );
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized", errorRef },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid body", errorRef },
      { status: 400 },
    );
  }

  const parsed = FeedbackSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid submission", issues: parsed.error.flatten(), errorRef },
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
      origin: request.headers.get("origin") ?? new URL(request.url).origin,
    });
  } catch (err) {
    console.error("[feedback.submit] bundle build failed", { errorRef, userId, err });
    return NextResponse.json(
      { ok: false, error: "Could not build feedback bundle", errorRef },
      { status: 500 },
    );
  }

  let report;
  try {
    report = await prisma.feedbackReport.create({
      data: {
        userId,
        sessionId: submission.sessionId ?? null,
        userText: submission.userText?.trim() ? submission.userText : null,
        triedToDoText: submission.triedToDoText ?? null,
        userAgent: submission.userAgent ?? null,
        url: submission.url ?? null,
        area: submission.area ?? null,
        checklistState: submission.checklistState as never,
        clientState: (submission.clientState ?? null) as never,
        bundle: bundle as never,
        filedByGuest: false,
      },
      select: { id: true },
    });
  } catch (err) {
    console.error("[feedback.submit] insert failed", { errorRef, userId, err });
    return NextResponse.json(
      { ok: false, error: "Could not save feedback", errorRef },
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
      hasUserText: Boolean(submission.userText?.trim()),
    },
  });

  const isAdmin = await isAdminSession();

  // Admin convenience: auto-mint an agent token on submit so the Thank-you
  // screen can show a ready-to-paste prompt. Same semantics as the manual
  // mint at /api/admin/feedback/[id]/mint-token — row + audit + 15-min TTL.
  let agentPrompt: string | undefined;
  if (isAdmin) {
    try {
      const minted = signAgentToken({ reportId: report.id });
      await prisma.agentAccessToken.create({
        data: {
          reportId: report.id,
          mintedById: userId,
          jti: minted.jti,
          expiresAt: minted.expiresAt,
        },
      });
      await logAdminAccess({
        adminId: userId,
        path: "/api/feedback/submit",
        action: "view",
        targetUserId: userId,
        context: {
          feedbackReportId: report.id,
          tokenJti: minted.jti,
          action: "auto_mint_on_submit",
        },
      });
      const origin = request.headers.get("origin") || new URL(request.url).origin;
      const fetchUrl = `${origin}/api/agent/feedback/${report.id}?token=${minted.token}`;
      agentPrompt = [
        `curl -s '${fetchUrl}'`,
        ``,
        `Run the curl above to fetch { report, bundle } for AgentEnvoy feedback report ${report.id}.`,
        ``,
        `Bundle triage map — start where the complaint points:`,
        `  • Widget offered wrong slots / today missing → bundle.replay.slotsByDay is what the scoring engine serves now. bundle.recentLinks[].rulesJson is the rule that drove it. Compare replay vs. rule + guestPicks.window.`,
        `  • Greeting / first-message wrong → bundle.messages.recentTurns[0] (or sharedChannel.recentTurns[0] for guest bundles).`,
        `  • Timezone confusion → bundle.clientState.viewerTimezone vs. the host tz implied by replay.hostTimezone.`,
        `  • Link went to wrong place → scan messages for action.params.url / action.params.linkCode.`,
        `  • Classification / intent bugs → bundle.filingContext.suspectedIncidentTurn + recentLinks[].rulesJson.`,
        ``,
        `What the bundle does NOT carry: raw Google Calendar events (only title+time via bundle.calendar), secrets, cross-user data. If you need something outside the bundle, say so — do not fabricate it.`,
        ``,
        `Then follow agentenvoy/PLAYBOOK.md → "Debug bundle handling".`,
      ].join("\n");
    } catch (err) {
      // Non-fatal: if mint fails (e.g. AGENT_TOKEN_SECRET unset), the Thank-you
      // screen still shows the Open-report link as a fallback path.
      console.error("[feedback.submit] auto-mint failed", { userId, err });
    }
  }

  return NextResponse.json({ ok: true, reportId: report.id, isAdmin, agentPrompt });
}
