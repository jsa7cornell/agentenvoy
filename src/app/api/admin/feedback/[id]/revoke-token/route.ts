/**
 * POST /api/admin/feedback/[id]/revoke-token
 *
 * Admin-gated. Revokes either a specific token (by jti) or all active
 * tokens on a report. Writes an audit row for each.
 *
 * See proposals/2026-04-21_agent-accessible-feedback-pipeline §2.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const admin = await requireAdminContext(`/admin/feedback/${id}`);

  let body: { jti?: string } = {};
  try {
    body = (await request.json()) as { jti?: string };
  } catch {
    /* empty body = revoke all */
  }

  const report = await prisma.feedbackReport.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!report) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const now = new Date();
  const where = body.jti
    ? { jti: body.jti, reportId: report.id, revokedAt: null }
    : { reportId: report.id, revokedAt: null };

  const affected = await prisma.agentAccessToken.updateMany({
    where,
    data: { revokedAt: now },
  });

  await logAdminAccess({
    adminId: admin.id,
    path: "/api/admin/feedback/:id/revoke-token",
    action: "view",
    targetUserId: report.userId,
    context: {
      feedbackReportId: report.id,
      tokenJti: body.jti ?? null,
      action: "revoke",
      affectedCount: affected.count,
    },
  });

  return NextResponse.json({ revoked: affected.count });
}
