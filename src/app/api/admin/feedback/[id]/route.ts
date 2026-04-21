/**
 * GET  /api/admin/feedback/[id] — same-auth JSON version of the admin detail page.
 *                                 Cheap Option A add-on from proposal §2.
 * PATCH /api/admin/feedback/[id] — update status on a report. Writes an audit row.
 *
 * Admin-gated (userClass === "admin" via requireAdminContext).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";

export const dynamic = "force-dynamic";

const STATUS_VALUES = ["new", "acknowledged", "in_progress", "resolved", "wontfix"] as const;
const PatchSchema = z.object({
  status: z.enum(STATUS_VALUES),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const admin = await requireAdminContext(`/admin/feedback/${id}`);

  const report = await prisma.feedbackReport.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!report) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await logAdminAccess({
    adminId: admin.id,
    path: "/api/admin/feedback/:id",
    action: "view",
    targetUserId: report.userId,
    context: { feedbackReportId: report.id, via: "admin-json" },
  });

  return NextResponse.json(
    {
      id: report.id,
      createdAt: report.createdAt.toISOString(),
      status: report.status,
      area: report.area,
      resolved: report.resolved,
      resolvedAt: report.resolvedAt?.toISOString() ?? null,
      resolvedBy: report.resolvedBy,
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
      bundle: report.bundle,
    },
    { headers: { "Referrer-Policy": "no-referrer" } },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const admin = await requireAdminContext(`/admin/feedback/${id}`);

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const existing = await prisma.feedbackReport.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true, resolved: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const nextStatus = parsed.data.status;
  const nowResolved = nextStatus === "resolved" || nextStatus === "wontfix";

  const data: {
    status: string;
    resolved: boolean;
    resolvedAt?: Date | null;
    resolvedBy?: string | null;
  } = {
    status: nextStatus,
    resolved: nowResolved,
  };
  if (nowResolved && !existing.resolved) {
    data.resolvedAt = new Date();
    data.resolvedBy = admin.id;
  } else if (!nowResolved && existing.resolved) {
    data.resolvedAt = null;
    data.resolvedBy = null;
  }

  const updated = await prisma.feedbackReport.update({
    where: { id },
    data,
    select: { id: true, status: true, resolved: true, resolvedAt: true, resolvedBy: true },
  });

  await logAdminAccess({
    adminId: admin.id,
    path: "/api/admin/feedback/:id",
    action: "view",
    targetUserId: existing.userId,
    context: {
      feedbackReportId: id,
      action: "status_update",
      from: existing.status,
      to: nextStatus,
    },
  });

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    resolved: updated.resolved,
    resolvedAt: updated.resolvedAt?.toISOString() ?? null,
    resolvedBy: updated.resolvedBy,
  });
}
