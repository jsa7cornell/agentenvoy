/**
 * GET /api/me/links/live?codes=code1,code2,...
 *
 * Batch endpoint: given a list of link codes from feed message metadata,
 * return the CURRENT state of those links directly from the DB / structuredRules.
 * Used by feed.tsx to render LinkCard with live data instead of the frozen
 * linkCardMeta snapshot.
 *
 * Returns: { links: { [code]: LiveLinkMeta } }
 *
 * Handles both link kinds:
 *   - personalized / group: queried from NegotiationLink
 *   - bookable: compiled from user.preferences.explicit.structuredRules
 *
 * Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md §PR2
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseLinkParameters } from "@/lib/link-parameters";
import { compileBookableLinks, getBusinessHoursWindow } from "@/lib/availability-rules";
import type { AvailabilityRule } from "@/lib/availability-rules";
import { emojiForActivity } from "@/lib/activity-vocab";

/** Shape fed to the feed's LinkCard — matches the existing BookableMeta type in feed.tsx. */
export type LiveLinkMeta = {
  title?: string;
  linkUrl?: string;
  daysOfWeek?: number[];
  timeStart?: string;
  timeEnd?: string;
  durationMinutes?: number;
  format?: string;
  activityIcon?: string | null;
  inviteeNames?: string[];
  guestPicks?: Record<string, unknown>;
  recurrence?: { pattern?: string };
};

const MAX_CODES = 50;

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const codesParam = request.nextUrl.searchParams.get("codes") ?? "";
  const codes = codesParam
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, MAX_CODES);

  if (codes.length === 0) {
    return NextResponse.json({ links: {} });
  }

  const result: Record<string, LiveLinkMeta> = {};

  // ── Personalized / group links (NegotiationLink table) ───────────────────

  const nlRows = await prisma.negotiationLink.findMany({
    where: { userId, code: { in: codes } },
    select: {
      code: true,
      type: true,
      customTitle: true,
      inviteeName: true,
      inviteeNames: true,
      parameters: true,
      recurrence: true,
    },
  });

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://agentenvoy.ai";

  for (const link of nlRows) {
    if (!link.code) continue;
    const params = parseLinkParameters(link.parameters ?? null);
    const activity = typeof params.activity === "string" ? params.activity : null;
    const format = typeof params.format === "string" ? params.format : undefined;
    const rawIcon = typeof params.activityIcon === "string" ? params.activityIcon : null;
    const derivedIcon = rawIcon ?? emojiForActivity(activity, (format ?? null) as "video" | "phone" | "in-person" | null);
    const names =
      Array.isArray(link.inviteeNames) && link.inviteeNames.length > 0
        ? link.inviteeNames
        : link.inviteeName
          ? [link.inviteeName]
          : undefined;

    const meta: LiveLinkMeta = {
      title: link.customTitle ?? link.inviteeName ?? undefined,
      durationMinutes: typeof params.duration === "number" ? params.duration : undefined,
      format,
      activityIcon: derivedIcon ?? undefined,
      guestPicks:
        params.guestPicks && typeof params.guestPicks === "object"
          ? (params.guestPicks as Record<string, unknown>)
          : undefined,
      recurrence:
        link.recurrence && typeof link.recurrence === "object"
          ? (link.recurrence as unknown as Record<string, unknown>)
          : undefined,
      inviteeNames: names,
    };
    result[link.code] = meta;
  }

  // ── Bookable links (structuredRules in user preferences) ─────────────────

  // Only query prefs if any requested codes weren't already resolved above.
  const resolvedCodes = new Set(Object.keys(result));
  const unresolvedCodes = codes.filter((c) => !resolvedCodes.has(c));

  if (unresolvedCodes.length > 0) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { meetSlug: true, preferences: true },
    });

    if (user) {
      const prefs = (user.preferences as Record<string, unknown> | null) ?? {};
      const explicit = (prefs.explicit as Record<string, unknown> | undefined) ?? {};
      const rules = (explicit.structuredRules as AvailabilityRule[] | undefined) ?? [];
      const bookableLinks = compileBookableLinks(rules, getBusinessHoursWindow(prefs));

      for (const oh of bookableLinks) {
        if (!unresolvedCodes.includes(oh.linkCode)) continue;
        // Find the originating rule to get timeStart, timeEnd, daysOfWeek, activityIcon
        const rule = rules.find((r) => r.bookable?.linkCode === oh.linkCode);
        const rawIcon = rule?.bookable?.activityIcon ?? null;
        const derivedIcon =
          rawIcon ?? emojiForActivity(oh.title ?? null, (oh.format ?? null) as "video" | "phone" | "in-person" | null);

        const meta: LiveLinkMeta = {
          title: rule?.bookable?.name ?? oh.title ?? undefined,
          daysOfWeek: rule?.daysOfWeek ?? oh.daysOfWeek,
          timeStart: rule?.timeStart,
          timeEnd: rule?.timeEnd,
          durationMinutes: oh.durationMinutes,
          format: oh.format ?? undefined,
          activityIcon: derivedIcon ?? undefined,
          guestPicks:
            rule?.bookable?.guestPicks && typeof rule.bookable.guestPicks === "object"
              ? (rule.bookable.guestPicks as Record<string, unknown>)
              : undefined,
          recurrence:
            rule?.bookable?.recurrence && typeof rule.bookable.recurrence === "object"
              ? (rule.bookable.recurrence as unknown as Record<string, unknown>)
              : undefined,
          linkUrl: user.meetSlug
            ? `${baseUrl}/meet/${user.meetSlug}/${oh.linkCode}`
            : undefined,
        };
        result[oh.linkCode] = meta;
      }
    }
  }

  return NextResponse.json({ links: result });
}
