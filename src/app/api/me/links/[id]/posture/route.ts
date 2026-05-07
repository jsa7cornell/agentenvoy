/**
 * PATCH /api/me/links/[id]/posture
 *
 * Writes a partial posture update to a single variance link's parameters
 * JSON. Accepts the same PostureUpdate shape that applyPostureToScope
 * expects — availability, duration, bufferMinutes, format, eveningsPosture.
 *
 * Used by the unified link-edit modal (PR-D, proposal
 * 2026-05-06_link-config-canonical-model-and-unified-edit §14) when
 * editing a Bookable / personalized NegotiationLink.
 *
 * The special linkId "primary" is rejected — primary link writes go
 * through POST /api/me/scheduling-defaults.
 *
 * Validates the caller owns the link (userId check). Returns 404 when
 * the link is not found or not owned by the caller.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { applyPostureToScope } from "@/lib/links/scope";
import type { PostureUpdate } from "@/lib/links/scope";
import type { AvailabilityWindow } from "@/lib/link-parameters";
import { getLinkPosture } from "@/lib/links/posture";
import type { UserPreferences } from "@/lib/scoring";
import { prisma } from "@/lib/prisma";

const ALLOWED_FORMATS = ["video", "phone", "in-person"] as const;
const ALLOWED_DURATIONS = [15, 25, 30, 45, 60, 90];
const ALLOWED_BUFFERS = [0, 5, 10, 15, 30];
const ALLOWED_EVENINGS = ["protected", "vip_only", "open"] as const;

function isValidAvailabilityWindows(v: unknown): v is AvailabilityWindow[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every(
    (w) =>
      w != null &&
      typeof w === "object" &&
      Array.isArray((w as AvailabilityWindow).days) &&
      (w as AvailabilityWindow).days.length > 0 &&
      typeof (w as AvailabilityWindow).startMinutes === "number" &&
      typeof (w as AvailabilityWindow).endMinutes === "number" &&
      (w as AvailabilityWindow).endMinutes > (w as AvailabilityWindow).startMinutes
  );
}

/** Resolve a NegotiationLink by either its Prisma `id` or its short URL `code`. */
async function findLink(idOrCode: string, userId: string) {
  // cuid2 ids start with 'c' and are 24+ chars; short codes are ≤8 chars.
  const byCode = idOrCode.length <= 8;
  return prisma.negotiationLink.findFirst({
    where: byCode
      ? { code: idOrCode, userId }
      : { id: idOrCode, userId },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const link = await findLink(id, session.user.id);
  if (!link) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });
  const posture = getLinkPosture(link, user as { preferences?: UserPreferences | null } | null);
  return NextResponse.json(posture);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  if (!id || id === "primary") {
    return NextResponse.json(
      { error: "Use POST /api/me/scheduling-defaults for the primary link" },
      { status: 400 }
    );
  }

  // Verify the caller owns this link (by id or short code).
  const link = await findLink(id, session.user.id);
  if (!link) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const resolvedId = link.id;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: PostureUpdate = {};

  if ("availability" in body) {
    if (!isValidAvailabilityWindows(body.availability)) {
      return NextResponse.json(
        {
          error: "Invalid availability",
          field: "availability",
          reason: "must be a non-empty array of {days, startMinutes, endMinutes}",
        },
        { status: 400 }
      );
    }
    updates.availability = body.availability;
  }

  if ("duration" in body) {
    if (!ALLOWED_DURATIONS.includes(body.duration as number)) {
      return NextResponse.json(
        { error: "Invalid duration", field: "duration", allowed: ALLOWED_DURATIONS },
        { status: 400 }
      );
    }
    updates.duration = body.duration as number;
  }

  if ("bufferMinutes" in body) {
    if (!ALLOWED_BUFFERS.includes(body.bufferMinutes as number)) {
      return NextResponse.json(
        { error: "Invalid bufferMinutes", field: "bufferMinutes", allowed: ALLOWED_BUFFERS },
        { status: 400 }
      );
    }
    updates.bufferMinutes = body.bufferMinutes as number;
  }

  if ("format" in body) {
    if (!(ALLOWED_FORMATS as readonly unknown[]).includes(body.format)) {
      return NextResponse.json(
        { error: "Invalid format", field: "format", allowed: ALLOWED_FORMATS },
        { status: 400 }
      );
    }
    updates.format = body.format as PostureUpdate["format"];
  }

  if ("eveningsPosture" in body) {
    if (!(ALLOWED_EVENINGS as readonly unknown[]).includes(body.eveningsPosture)) {
      return NextResponse.json(
        { error: "Invalid eveningsPosture", field: "eveningsPosture", allowed: ALLOWED_EVENINGS },
        { status: 400 }
      );
    }
    updates.eveningsPosture = body.eveningsPosture as PostureUpdate["eveningsPosture"];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No recognized fields in payload" }, { status: 400 });
  }

  const result = await applyPostureToScope(updates, [resolvedId], session.user.id);
  return NextResponse.json({ ok: true, varianceWrites: result.varianceWrites });
}
