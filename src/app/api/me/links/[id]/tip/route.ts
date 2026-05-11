/**
 * POST /api/me/links/[id]/tip
 *
 * Patches Link.parameters.tip — the host-authored meeting tip. Host-only
 * (PAT not required; uses NextAuth session). The pencil affordance on the
 * event page calls this on save.
 *
 * Per Phase 2 PR2 (SEED proposal § 1.5): tip is authored at link create
 * time (LLM seed) OR via this endpoint (host inline-edit). Stored on the
 * Link.parameters JSON column.
 *
 * Body: { tip: string }  // empty string clears the tip
 *
 * Returns: 200 { ok: true } | 401 | 403 | 404 | 400 (invalid body)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authSession = await getServerSession(authOptions);
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const tipRaw = body?.tip;
  if (typeof tipRaw !== "string") {
    return NextResponse.json({ error: "tip must be a string" }, { status: 400 });
  }
  const tip = tipRaw.trim().slice(0, 1000); // cap at 1k chars

  const link = await prisma.negotiationLink.findUnique({
    where: { id },
    select: { id: true, userId: true, parameters: true },
  });
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (link.userId !== authSession.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params0 = (link.parameters as Prisma.JsonObject | null) ?? {};
  // Empty tip clears the key entirely (undefined excluded from spread)
  const updated: Prisma.JsonObject = tip
    ? { ...params0, tip }
    : Object.fromEntries(Object.entries(params0).filter(([k]) => k !== "tip"));

  // Phase 2 PR3c — when a host edits the tip, also clear hostNote so
  // legacy data doesn't shadow the new authored tip in the fallback chain
  // (getLinkPosture: link.parameters.tip ?? link.hostNote ?? null).
  // hostNote column is DEPRECATED 2026-05-11; will be dropped after one
  // release cycle. This write prevents stale hostNote from surfacing via
  // the fallback after the host explicitly edits the tip.
  //
  // TODO(link-edit-modal): link-edit-modal.tsx may also write tip via a
  // separate path. If that path is wired, ensure it also clears hostNote
  // on write. The parallel agent handling link-edit-modal.tsx should
  // coordinate with this endpoint. See EVENTPAGE punch-list #9.
  await prisma.negotiationLink.update({
    where: { id },
    data: {
      parameters: updated,
      // Clear deprecated hostNote on explicit tip save so it doesn't shadow.
      hostNote: null,
    },
  });

  return NextResponse.json({ ok: true, tip: tip || null });
}
