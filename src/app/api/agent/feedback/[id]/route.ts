/**
 * GET /api/agent/feedback/[id]?token=<jwt>
 *
 * Agent-facing read endpoint. The token is a 15-min HS256 JWT minted via
 * /api/admin/feedback/[id]/mint-token. See proposals/2026-04-21.
 *
 * Gate order (each failure writes AdminAccessLog { action: "view_denied" }
 * with a closed ViewDeniedReason; returns 401/403/404/410/429):
 *   1. signature + aud + exp
 *   2. token row exists
 *   3. reportId matches URL
 *   4. not revoked
 *   5. fetchCount < cap (atomic updateMany ensures race-safe cap)
 *
 * Success: returns { report, bundle } JSON with Cache-Control: no-store
 * and Referrer-Policy: no-referrer. AdminAccessLog row attributes the read
 * to the minting admin ("the agent acts on their behalf").
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAdminAccess } from "@/lib/admin/access-log";
import {
  AGENT_TOKEN_FETCH_CAP,
  verifyAgentTokenSignature,
  type ViewDeniedReason,
} from "@/lib/feedback/agent-token";

export const dynamic = "force-dynamic";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const REASON_STATUS: Record<ViewDeniedReason, number> = {
  bad_signature: 401,
  token_not_found: 401,
  reportid_mismatch: 403,
  revoked: 410,
  expired: 410,
  rate_limited: 429,
};

function deny(
  reason: ViewDeniedReason,
  ctx: {
    adminId?: string | null;
    reportId?: string | null;
    targetUserId?: string | null;
    tokenJti?: string | null;
  },
): NextResponse {
  if (ctx.adminId) {
    // Fire-and-forget; the helper swallows its own errors.
    void logAdminAccess({
      adminId: ctx.adminId,
      path: "/api/agent/feedback/:id",
      action: "view_denied",
      targetUserId: ctx.targetUserId ?? null,
      context: {
        reason,
        via: "agent-token",
        feedbackReportId: ctx.reportId ?? null,
        tokenJti: ctx.tokenJti ?? null,
      },
    });
  }
  return NextResponse.json(
    { error: "view_denied", reason },
    { status: REASON_STATUS[reason], headers: SECURITY_HEADERS },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return NextResponse.json(
      { error: "missing_token" },
      { status: 401, headers: SECURITY_HEADERS },
    );
  }

  const verify = verifyAgentTokenSignature(token);
  if (!verify.ok) {
    // No jti yet — can't attribute to a minter. Return without audit row.
    return NextResponse.json(
      { error: "view_denied", reason: verify.reason },
      { status: REASON_STATUS[verify.reason], headers: SECURITY_HEADERS },
    );
  }
  const { claims } = verify;

  const tokenRow = await prisma.agentAccessToken.findUnique({
    where: { jti: claims.jti },
    select: {
      id: true,
      reportId: true,
      mintedById: true,
      fetchCount: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!tokenRow) {
    return deny("token_not_found", { reportId: id });
  }

  if (tokenRow.reportId !== id || claims.reportId !== id) {
    return deny("reportid_mismatch", {
      adminId: tokenRow.mintedById,
      reportId: id,
      tokenJti: claims.jti,
    });
  }

  if (tokenRow.revokedAt) {
    return deny("revoked", {
      adminId: tokenRow.mintedById,
      reportId: id,
      tokenJti: claims.jti,
    });
  }

  if (tokenRow.expiresAt.getTime() <= Date.now()) {
    return deny("expired", {
      adminId: tokenRow.mintedById,
      reportId: id,
      tokenJti: claims.jti,
    });
  }

  // Atomic cap increment: only increment if still under the cap. If 0 rows
  // affected, a concurrent fetch hit the cap first.
  const incremented = await prisma.agentAccessToken.updateMany({
    where: {
      jti: claims.jti,
      fetchCount: { lt: AGENT_TOKEN_FETCH_CAP },
      revokedAt: null,
    },
    data: {
      fetchCount: { increment: 1 },
      usedAt: new Date(),
    },
  });
  if (incremented.count === 0) {
    return deny("rate_limited", {
      adminId: tokenRow.mintedById,
      reportId: id,
      tokenJti: claims.jti,
    });
  }
  const newFetchCount = tokenRow.fetchCount + 1;

  const report = await prisma.feedbackReport.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!report) {
    return deny("token_not_found", {
      adminId: tokenRow.mintedById,
      reportId: id,
      tokenJti: claims.jti,
    });
  }

  await logAdminAccess({
    adminId: tokenRow.mintedById,
    path: "/api/agent/feedback/:id",
    action: "view",
    targetUserId: report.userId,
    context: {
      feedbackReportId: report.id,
      tokenJti: claims.jti,
      via: "agent-token",
      fetchCount: newFetchCount,
    },
  });

  return NextResponse.json(
    {
      report: {
        id: report.id,
        createdAt: report.createdAt.toISOString(),
        status: report.status,
        area: report.area,
        resolved: report.resolved,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        userText: report.userText,
        triedToDoText: report.triedToDoText,
        userAgent: report.userAgent,
        url: report.url,
        filedByGuest: report.filedByGuest,
        guestName: report.guestName,
        guestEmail: report.guestEmail,
        host: report.user ? { id: report.user.id, email: report.user.email } : null,
        checklistState: report.checklistState,
        clientState: report.clientState,
      },
      bundle: report.bundle,
      token: {
        jti: claims.jti,
        fetchCount: newFetchCount,
        fetchCap: AGENT_TOKEN_FETCH_CAP,
        expiresAt: tokenRow.expiresAt.toISOString(),
      },
    },
    { headers: SECURITY_HEADERS },
  );
}
