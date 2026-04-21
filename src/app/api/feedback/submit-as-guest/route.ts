/**
 * POST /api/feedback/submit-as-guest — deal-room guest feedback (2026-04-21).
 *
 * Auth: linkCode only. No NextAuth session (guests don't have one). The
 * linkCode is the same auth primitive the deal-room chat already uses; the
 * threat model is unchanged.
 *
 * Load-bearing integrity checks (from the decided proposal):
 *   B1 — guest identity is SERVER-DERIVED from NegotiationSession state,
 *        never read from the request body. Zod schema is `.strict()` so a
 *        body carrying `guestName`/`guestEmail` is rejected at the boundary.
 *   B3 — if `sessionId` is present, it MUST belong to the linkCode's link.
 *        Mismatch → 400. Without this, an attacker with linkCode A could
 *        pass sessionId from linkCode B and exfiltrate B's messages via the
 *        bundle builder.
 *
 * Rate limit: in-memory token bucket per linkCode (5/hour). Fine for v1;
 * will swap to a distributed store if we ever run multi-region.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { FeedbackSubmitAsGuestSchema } from "@/lib/feedback/schema";
import { buildGuestFeedbackBundle } from "@/lib/feedback/build-guest-bundle";
import { track } from "@/lib/analytics/track";
import { isAdminSession } from "@/lib/admin-auth";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
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

// Process-local rate-limit state. Acceptable for v1 (single Vercel region);
// a bad-faith attacker can still get past it by hitting a different lambda
// instance, but that's in line with how the deal-room chat is rate-limited.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const rateBucket = new Map<string, number[]>();

function rateLimitHit(key: string): boolean {
  const now = Date.now();
  const hits = (rateBucket.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateBucket.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBucket.set(key, hits);
  return false;
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid body", errorRef },
      { status: 400 },
    );
  }

  const parsed = FeedbackSubmitAsGuestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid submission", issues: parsed.error.flatten(), errorRef },
      { status: 400 },
    );
  }
  const submission = parsed.data;

  if (rateLimitHit(submission.linkCode)) {
    return NextResponse.json(
      { ok: false, error: "Too many reports", errorRef },
      { status: 429 },
    );
  }

  // Resolve linkCode → NegotiationLink + host. If the link doesn't exist,
  // return 404 (not 401 — 401 would leak that an admin auth gate exists).
  const link = await prisma.negotiationLink.findUnique({
    where: { code: submission.linkCode },
    select: {
      id: true,
      code: true,
      userId: true,
      user: { select: { id: true, email: true } },
    },
  });
  if (!link || !link.code) {
    return NextResponse.json(
      { ok: false, error: "Link not found", errorRef },
      { status: 404 },
    );
  }

  // B3: sessionId → linkCode scope check. If sessionId is present, verify
  // it belongs to this link. Mismatch is a hard error, not a silent drop.
  let sessionRow: {
    id: string;
    title: string | null;
    status: string;
    agreedTime: Date | null;
    guestName: string | null;
    guestEmail: string | null;
  } | null = null;
  if (submission.sessionId) {
    const session = await prisma.negotiationSession.findUnique({
      where: { id: submission.sessionId },
      select: {
        id: true,
        linkId: true,
        title: true,
        status: true,
        agreedTime: true,
        guestName: true,
        guestEmail: true,
      },
    });
    if (!session || session.linkId !== link.id) {
      return NextResponse.json(
        { ok: false, error: "Session does not belong to this link", errorRef },
        { status: 400 },
      );
    }
    sessionRow = {
      id: session.id,
      title: session.title,
      status: session.status,
      agreedTime: session.agreedTime,
      guestName: session.guestName,
      guestEmail: session.guestEmail,
    };
  }

  // B1: server-derived guest identity. We read from NegotiationSession
  // state only. The request body schema is `.strict()` so there's no way
  // a body-provided `guestName` could have smuggled in.
  const guestName = sessionRow?.guestName ?? null;
  const guestEmail = sessionRow?.guestEmail ?? null;

  let bundle;
  try {
    bundle = await buildGuestFeedbackBundle({
      link: { id: link.id, code: link.code, hostId: link.userId },
      host: { id: link.user.id, email: link.user.email },
      session: sessionRow,
      submission,
      appVersion: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
      origin: request.headers.get("origin") ?? new URL(request.url).origin,
    });
  } catch (err) {
    console.error("[feedback.submit-as-guest] bundle build failed", {
      errorRef,
      linkCode: submission.linkCode,
      err,
    });
    return NextResponse.json(
      { ok: false, error: "Could not build feedback bundle", errorRef },
      { status: 500 },
    );
  }

  // Persist to FeedbackReport, keyed to the host. `filedByGuest: true` is
  // set HERE at the endpoint — never from the request body.
  const checklistState = {
    messages: submission.includeContext,
    sessions: submission.includeContext,
    calendar: false,
    errors: false,
    console: false,
  };

  let report;
  try {
    report = await prisma.feedbackReport.create({
      data: {
        userId: link.userId,
        sessionId: submission.sessionId ?? null,
        userText: submission.userText?.trim() ? submission.userText : null,
        triedToDoText: null,
        userAgent: submission.userAgent ?? null,
        url: submission.url ?? null,
        area: submission.area ?? null,
        checklistState: checklistState as never,
        clientState: (submission.clientState ?? null) as never,
        bundle: bundle as never,
        filedByGuest: true,
        guestName,
        guestEmail,
      },
      select: { id: true },
    });
  } catch (err) {
    console.error("[feedback.submit-as-guest] insert failed", {
      errorRef,
      linkCode: submission.linkCode,
      err,
    });
    return NextResponse.json(
      { ok: false, error: "Could not save feedback", errorRef },
      { status: 500 },
    );
  }

  await track({
    name: "feedback.report_submitted",
    userId: link.userId,
    sessionId: submission.sessionId ?? null,
    props: {
      messages: checklistState.messages,
      sessions: checklistState.sessions,
      calendar: false,
      errors: false,
      console: false,
      filedByGuest: true,
      hasUserText: Boolean(submission.userText?.trim()),
    },
  });

  // Admin convenience: if the submitter happens to be logged in as an admin
  // (John testing from a deal-room as a guest), auto-mint an agent token so
  // the Thank-you screen can show the copy-prompt shortcut. Same semantics
  // as the authenticated submit path.
  const session = await getServerSession(authOptions);
  const isAdmin = session?.user?.id ? await isAdminSession() : false;
  let agentPrompt: string | undefined;
  if (isAdmin && session?.user?.id) {
    try {
      const minted = signAgentToken({ reportId: report.id });
      await prisma.agentAccessToken.create({
        data: {
          reportId: report.id,
          mintedById: session.user.id,
          jti: minted.jti,
          expiresAt: minted.expiresAt,
        },
      });
      await logAdminAccess({
        adminId: session.user.id,
        path: "/api/feedback/submit-as-guest",
        action: "view",
        targetUserId: link.userId,
        context: {
          feedbackReportId: report.id,
          tokenJti: minted.jti,
          action: "auto_mint_on_submit",
        },
      });
      const reqOrigin = request.headers.get("origin") || new URL(request.url).origin;
      const fetchUrl = `${reqOrigin}/api/agent/feedback/${report.id}?token=${minted.token}`;
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
      console.error("[feedback.submit-as-guest] auto-mint failed", { err });
    }
  }

  return NextResponse.json({ ok: true, reportId: report.id, isAdmin, agentPrompt });
}
