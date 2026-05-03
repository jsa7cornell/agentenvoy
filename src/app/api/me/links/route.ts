/**
 * Unified read endpoint for the scheduling links chip list at the top
 * of the feed (proposal `2026-04-23_primary-link-config-convergence`
 * §3.2 pattern (b)). Returns a denormalized view of every way someone
 * can book time with the host:
 *
 *   - `standard`   — the user's generic share-everywhere link (meetSlug)
 *   - `bookable`   — per-rule links compiled from structuredRules (was `office_hours`)
 *   - `personalized` — unarchived, unexpired negotiationLinks (was `contextual`)
 *
 * NOTE: `kind: "standard"` and `kind: "bookable"` are the new wire values.
 * Consumers reading `kind: "office_hours"` or `kind: "contextual"` should
 * migrate to the new values. TODO(vocab-cleanup): remove old kind values.
 *
 * The chip list is read-only today; creation still goes through
 * /dashboard/my-links. When `/api/me/scheduling-state` ships, this
 * endpoint merges into it.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { compileBookableLinks } from "@/lib/availability-rules";
import type { AvailabilityPreference } from "@/lib/availability-rules";

type LinkEntry =
  | {
      kind: "standard";
      title: string;
      url: string;
      slug: string;
    }
  | {
      kind: "bookable";
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
      kind: "personalized";
      title: string;
      url: string;
      slug: string;
      code: string;
      inviteeName: string | null;
      topic: string | null;
      expiresAt: string | null;
      createdAt: string;
      // Per-field "Edited" pill metadata. Set by update_link when material
      // fields change (proposal 2026-04-28 §3.C). Pill freshness check is
      // client-side (5min window default); these fields are passed through
      // verbatim.
      lastMaterialEditAt: string | null;
      lastEditedFields: string[];
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

  // Primary link — always first; omitted if no meetSlug (account not
  // yet initialized). `kind: "standard"` is preserved on the wire for
  // back-compat with existing consumers; user-visible copy uses "primary".
  if (user.meetSlug) {
    links.push({
      kind: "standard",
      title: user.name ? `Meet ${user.name}` : "Primary link",
      url: `${baseUrl}/meet/${user.meetSlug}`,
      slug: user.meetSlug,
    });
  }

  // Bookable links — compiled from structuredRules.
  const prefs = (user.preferences as Record<string, unknown> | null) || {};
  const explicit = (prefs.explicit as Record<string, unknown> | undefined) || {};
  const rules = (explicit.structuredRules as AvailabilityPreference[] | undefined) || [];
  const bookableLinks = compileBookableLinks(rules);
  for (const oh of bookableLinks) {
    links.push({
      kind: "bookable",
      title: oh.title || "Drop-in Hours",
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

  // Personalized links — unarchived, unexpired.
  // TODO(vocab-cleanup): remove || "contextual" after migration
  const now = new Date();
  const personalized = await prisma.negotiationLink.findMany({
    where: {
      userId: session.user.id,
      type: { in: ["personalized", "contextual"] },
      OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
    },
    select: {
      code: true,
      slug: true,
      inviteeName: true,
      topic: true,
      expiresAt: true,
      createdAt: true,
      lastMaterialEditAt: true,
      lastEditedFields: true,
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  for (const c of personalized) {
    // `code` is nullable in schema, but personalized links always have one.
    // Skip any row that somehow doesn't (defensive, shouldn't happen).
    if (!c.code) continue;
    links.push({
      kind: "personalized",
      title: c.topic || c.inviteeName || "Single-use link",
      url: `${baseUrl}/meet/${c.slug}/${c.code}`,
      slug: c.slug,
      code: c.code,
      inviteeName: c.inviteeName,
      topic: c.topic,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
      lastMaterialEditAt: c.lastMaterialEditAt ? c.lastMaterialEditAt.toISOString() : null,
      lastEditedFields: c.lastEditedFields ?? [],
    });
  }

  return NextResponse.json({ links });
}
