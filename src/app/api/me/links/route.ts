/**
 * Unified read endpoint for the scheduling links chip list at the top
 * of the feed (proposal `2026-04-23_primary-link-config-convergence`
 * §3.2 pattern (b)). Returns a denormalized view of every way someone
 * can book time with the host:
 *
 *   - `standard`  — the user's generic share-everywhere link (meetSlug)
 *   - `office_hours` — per-rule links compiled from structuredRules
 *   - `contextual` — unarchived, unexpired negotiationLinks
 *
 * The chip list is read-only today; creation still goes through
 * /dashboard/my-links. When `/api/me/scheduling-state` ships, this
 * endpoint merges into it.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { compileOfficeHoursLinks } from "@/lib/availability-rules";
import type { AvailabilityRule } from "@/lib/availability-rules";

type LinkEntry =
  | {
      kind: "standard";
      title: string;
      url: string;
      slug: string;
    }
  | {
      kind: "office_hours";
      title: string;
      url: string;
      slug: string;
      code: string;
      windowStart: string;
      windowEnd: string;
      daysOfWeek: number[];
      durationMinutes: number;
      expiryDate: string | null;
    }
  | {
      kind: "contextual";
      title: string;
      url: string;
      slug: string;
      code: string;
      inviteeName: string | null;
      topic: string | null;
      expiresAt: string | null;
      createdAt: string;
    };

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, meetSlug: true, preferences: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://agentenvoy.ai";

  const links: LinkEntry[] = [];

  // Standard link — always first; omitted if no meetSlug (account not
  // yet initialized).
  if (user.meetSlug) {
    links.push({
      kind: "standard",
      title: user.name ? `Meet ${user.name}` : "Standard link",
      url: `${baseUrl}/meet/${user.meetSlug}`,
      slug: user.meetSlug,
    });
  }

  // Office-hours links — compiled from structuredRules.
  const prefs = (user.preferences as Record<string, unknown> | null) || {};
  const explicit = (prefs.explicit as Record<string, unknown> | undefined) || {};
  const rules = (explicit.structuredRules as AvailabilityRule[] | undefined) || [];
  const officeHours = compileOfficeHoursLinks(rules);
  for (const oh of officeHours) {
    links.push({
      kind: "office_hours",
      title: oh.title || "Office hours",
      url: `${baseUrl}/meet/${oh.linkSlug}/${oh.linkCode}`,
      slug: oh.linkSlug,
      code: oh.linkCode,
      windowStart: oh.windowStart,
      windowEnd: oh.windowEnd,
      daysOfWeek: oh.daysOfWeek,
      durationMinutes: oh.durationMinutes,
      expiryDate: oh.expiryDate ?? null,
    });
  }

  // Contextual links — unarchived, unexpired.
  const now = new Date();
  const contextual = await prisma.negotiationLink.findMany({
    where: {
      userId: session.user.id,
      type: "contextual",
      OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
    },
    select: {
      code: true,
      slug: true,
      inviteeName: true,
      topic: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  for (const c of contextual) {
    // `code` is nullable in schema, but contextual links always have one.
    // Skip any row that somehow doesn't (defensive, shouldn't happen).
    if (!c.code) continue;
    links.push({
      kind: "contextual",
      title: c.topic || c.inviteeName || "Contextual link",
      url: `${baseUrl}/meet/${c.slug}/${c.code}`,
      slug: c.slug,
      code: c.code,
      inviteeName: c.inviteeName,
      topic: c.topic,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
    });
  }

  return NextResponse.json({ links });
}
