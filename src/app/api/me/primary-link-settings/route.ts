/**
 * Primary-link settings — host-set guest-flexibility toggles.
 *
 * Reusable-link guest-picks proposal, decided 2026-04-28. Persists to
 * `preferences.explicit.primaryLinkGuestPicks` which the session-creation
 * route reads when minting a per-visit primary link, copying truthy values
 * into `link.parameters.guestPicks`.
 *
 * GET  → current toggles (or empty if unset).
 * PUT  → `{ guestPicks: { format?: boolean; duration?: boolean } }`.
 *        Both fields optional; absent fields preserve their existing values.
 *        Setting either to `false` is the same as turning it off (the toggle
 *        is one-bit per dimension, no allow-list path here — chat is the
 *        escape valve for the array form).
 *
 * No clear-on-edit: turning a toggle off doesn't change the host's underlying
 * default duration / format, so existing `negotiatedDuration` /
 * `negotiatedFormat` overrides on active sessions remain valid (they were
 * locked when the toggle was on; nothing about the host's defaults changed).
 * Clear-on-edit fires through `update_meeting_settings` for `defaultDuration`
 * changes (see `actions.ts:handleUpdateMeetingSettings`).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

interface PrimaryLinkGuestPicks {
  format?: boolean;
  duration?: boolean;
}

function parseGuestPicks(raw: unknown): PrimaryLinkGuestPicks | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") return { error: "guestPicks must be an object" };
  const r = raw as Record<string, unknown>;
  const out: PrimaryLinkGuestPicks = {};
  if (r.format !== undefined) {
    if (typeof r.format !== "boolean") return { error: "guestPicks.format must be boolean" };
    out.format = r.format;
  }
  if (r.duration !== undefined) {
    if (typeof r.duration !== "boolean") return { error: "guestPicks.duration must be boolean" };
    out.duration = r.duration;
  }
  return out;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const prefs = (user?.preferences as UserPreferences | null) ?? {};
  const guestPicks =
    (prefs.explicit?.primaryLinkGuestPicks as PrimaryLinkGuestPicks | undefined) ?? {};
  return NextResponse.json({ guestPicks });
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const parsed = parseGuestPicks(body.guestPicks);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const prefs: UserPreferences = (user?.preferences as UserPreferences | null) ?? {};
  const explicit = prefs.explicit ?? {};
  const existing =
    (explicit.primaryLinkGuestPicks as PrimaryLinkGuestPicks | undefined) ?? {};

  // Merge: absent body fields preserve existing values; explicit booleans win.
  const merged: PrimaryLinkGuestPicks = {
    ...existing,
    ...parsed,
  };

  // Drop the field entirely when both dimensions are off — keeps the JSON
  // blob clean for hosts who toggle on then off again.
  const collapsed: PrimaryLinkGuestPicks =
    !merged.format && !merged.duration ? {} : merged;

  const nextPrefs: UserPreferences = {
    ...prefs,
    explicit: {
      ...explicit,
      ...(Object.keys(collapsed).length > 0
        ? { primaryLinkGuestPicks: collapsed }
        : { primaryLinkGuestPicks: undefined }),
    },
  };

  // If the toggle was just collapsed to empty, drop the key entirely.
  if (Object.keys(collapsed).length === 0 && nextPrefs.explicit) {
    delete (nextPrefs.explicit as { primaryLinkGuestPicks?: unknown }).primaryLinkGuestPicks;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });

  return NextResponse.json({ ok: true, guestPicks: collapsed });
}
