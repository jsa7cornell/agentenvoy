/**
 * Bookable Link edit endpoint (Phase 1 PR 7).
 *
 * Companion to `confirm/route.ts` — that one creates a new Bookable Link rule
 * from a chat-flow proposal; this one updates an existing rule's editable
 * parameters from the Event Links sheet's Edit dialog. Both writers must
 * keep shape parity with `handleUpdateAvailabilityRule` (operation:
 * "modify", action: "bookable") at `app/src/agent/actions.ts`.
 *
 * Defense-in-depth shape:
 *   1. Authn — host must own the rule (it lives on `User.preferences.explicit
 *      .structuredRules[]`, so ownership is implicit).
 *   2. Body shape — validated against the BookableLinkProposal contract
 *      (mirrors `confirm/route.ts`).
 *   3. Cross-check — `linkSlug` and `linkCode` are NOT mutable from this
 *      endpoint; the rule's URL is permanent. The host can edit name /
 *      title / format / duration / days / window / dates only.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";
import { invalidateBehaviorSnapshot } from "@/lib/profile-gaps";
import {
  type AvailabilityPreference,
  normalizeLinkName,
} from "@/lib/availability-rules";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

interface OfficeHoursEditBody {
  title: string;
  format: "video" | "phone" | "in-person";
  durationMinutes: number;
  daysOfWeek: number[];
  timeStart: string;
  timeEnd: string;
  effectiveDate?: string;
  expiryDate?: string;
  /** Per-rule guest-flexibility opt-in. Both default false. Reusable-link
   *  guest-picks proposal, decided 2026-04-28. Absent body field means
   *  "preserve whatever the existing rule had" (handled at the merge below);
   *  an explicit `guestPicks: { format: false, duration: false }` overwrites. */
  guestPicks?: {
    format?: boolean;
    duration?: boolean;
  };
}

const VALID_FORMATS: ReadonlyArray<OfficeHoursEditBody["format"]> = [
  "video",
  "phone",
  "in-person",
];
const VALID_DURATIONS = new Set([15, 20, 30, 45, 60, 90]);

function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}

function isValidISODate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseEdit(raw: unknown): OfficeHoursEditBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "proposal must be an object" };
  const p = raw as Record<string, unknown>;
  if (typeof p.title !== "string" || !p.title.trim()) {
    return { error: "title is required" };
  }
  if (!VALID_FORMATS.includes(p.format as OfficeHoursEditBody["format"])) {
    return { error: `format must be one of: ${VALID_FORMATS.join(", ")}` };
  }
  if (typeof p.durationMinutes !== "number" || !VALID_DURATIONS.has(p.durationMinutes)) {
    return { error: "durationMinutes must be 15, 20, 30, 45, 60, or 90" };
  }
  if (!Array.isArray(p.daysOfWeek) || p.daysOfWeek.length === 0) {
    return { error: "daysOfWeek must be a non-empty array" };
  }
  for (const d of p.daysOfWeek) {
    if (typeof d !== "number" || d < 0 || d > 6) {
      return { error: "daysOfWeek entries must be 0..6" };
    }
  }
  if (!isValidHHMM(p.timeStart)) return { error: "timeStart must be HH:MM" };
  if (!isValidHHMM(p.timeEnd)) return { error: "timeEnd must be HH:MM" };
  if (p.timeStart >= p.timeEnd) return { error: "timeStart must be before timeEnd" };
  if (p.effectiveDate !== undefined && p.effectiveDate !== "" && !isValidISODate(p.effectiveDate)) {
    return { error: "effectiveDate must be YYYY-MM-DD" };
  }
  if (p.expiryDate !== undefined && p.expiryDate !== "" && !isValidISODate(p.expiryDate)) {
    return { error: "expiryDate must be YYYY-MM-DD" };
  }
  const rawGuestPicks = p.guestPicks as Record<string, unknown> | undefined;
  const parsedGuestPicks =
    rawGuestPicks && typeof rawGuestPicks === "object"
      ? {
          ...(typeof rawGuestPicks.format === "boolean" ? { format: rawGuestPicks.format } : {}),
          ...(typeof rawGuestPicks.duration === "boolean" ? { duration: rawGuestPicks.duration } : {}),
        }
      : undefined;
  return {
    title: p.title.trim(),
    format: p.format as OfficeHoursEditBody["format"],
    durationMinutes: p.durationMinutes,
    daysOfWeek: Array.from(new Set(p.daysOfWeek as number[])).sort((a, b) => a - b),
    timeStart: p.timeStart,
    timeEnd: p.timeEnd,
    effectiveDate:
      typeof p.effectiveDate === "string" && p.effectiveDate ? p.effectiveDate : undefined,
    expiryDate: typeof p.expiryDate === "string" && p.expiryDate ? p.expiryDate : undefined,
    ...(parsedGuestPicks && (parsedGuestPicks.format !== undefined || parsedGuestPicks.duration !== undefined)
      ? { guestPicks: parsedGuestPicks }
      : {}),
  };
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const ruleId = body.ruleId;
  if (typeof ruleId !== "string" || !ruleId) {
    return NextResponse.json({ error: "ruleId is required" }, { status: 400 });
  }

  const parsed = parseEdit(body.proposal);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const explicit = { ...(prefs.explicit ?? {}) };
  const existingRules =
    ((explicit as Record<string, unknown>).structuredRules as
      | AvailabilityPreference[]
      | undefined) ?? [];
  // TODO(vocab-cleanup): remove generalLinkName fallback after migration
  const generalLinkName =
    typeof explicit.primaryLinkName === "string" ? explicit.primaryLinkName :
    (typeof explicit.generalLinkName === "string" ? explicit.generalLinkName : undefined);

  const target = existingRules.find((r) => r.id === ruleId);
  if (!target) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }
  // TODO(vocab-cleanup): remove || "office_hours" after migration
  const targetBookable = target.bookable ?? (target as unknown as { officeHours?: typeof target.bookable }).officeHours;
  if ((target.action !== "bookable" && target.action !== ("office_hours" as string)) || !targetBookable) {
    return NextResponse.json(
      { error: "Rule is not a Bookable Link rule" },
      { status: 400 },
    );
  }

  // Per-host name uniqueness — same guard as confirm/route.ts and
  // handleUpdateAvailabilityRule. Excludes the rule we're editing.
  const taken = new Set<string>();
  for (const r of existingRules) {
    if (r.id === ruleId) continue;
    const bookableData = r.bookable ?? (r as unknown as { officeHours?: typeof r.bookable }).officeHours;
    if ((r.action !== "bookable" && r.action !== ("office_hours" as string)) || !bookableData) continue;
    const n = (bookableData.name ?? bookableData.title ?? "").trim();
    if (n) taken.add(normalizeLinkName(n));
  }
  taken.add(
    normalizeLinkName(
      generalLinkName && generalLinkName.trim() ? generalLinkName : "Primary link",
    ),
  );
  if (taken.has(normalizeLinkName(parsed.title))) {
    return NextResponse.json(
      { error: `You already have a link named "${parsed.title}". Pick a different name.` },
      { status: 409 },
    );
  }

  // Detect duration/format change BEFORE rewriting — the previous values are
  // used by the clear-on-edit step below. Reusable-link guest-picks proposal,
  // decided 2026-04-28.
  const prevDuration = targetBookable.durationMinutes;
  const prevFormat = targetBookable.format;
  const durationChanged = parsed.durationMinutes !== prevDuration;
  const formatChanged = parsed.format !== prevFormat;

  const nowIso = new Date().toISOString();
  const updated: AvailabilityPreference = {
    ...target,
    action: "bookable",
    timeStart: parsed.timeStart,
    timeEnd: parsed.timeEnd,
    daysOfWeek: parsed.daysOfWeek,
    effectiveDate: parsed.effectiveDate,
    expiryDate: parsed.expiryDate,
    bookable: {
      // Preserve immutable fields — linkSlug and linkCode are permanent.
      linkSlug: targetBookable.linkSlug,
      linkCode: targetBookable.linkCode,
      // guestPicks: prefer the body's value (host explicitly toggled in the
      // edit form); fall back to the existing rule's value when absent so an
      // edit that doesn't touch the toggles preserves them. Reusable-link
      // guest-picks proposal, 2026-04-28.
      ...(parsed.guestPicks
        ? { guestPicks: parsed.guestPicks }
        : targetBookable.guestPicks
          ? { guestPicks: targetBookable.guestPicks }
          : {}),
      // Update editable fields.
      name: parsed.title,
      title: parsed.title,
      format: parsed.format,
      durationMinutes: parsed.durationMinutes,
    },
  };

  const nextRules = existingRules.map((r) => (r.id === ruleId ? updated : r));
  (explicit as Record<string, unknown>).structuredRules = nextRules;
  const nextPrefs: UserPreferences = { ...prefs, explicit };

  await prisma.user.update({
    where: { id: userId },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });

  // Clear-on-edit invariant: when the host changes duration or format on an
  // Office Hours rule, any active guest session whose link traces back to
  // this rule (via NegotiationLink.recurringWindowId) must reset its
  // corresponding negotiated* override so the host's new value wins at slot-
  // search and confirm time. Mirrors handleUpdateLinkRules' negotiatedClearData
  // for contextual links. Reusable-link guest-picks proposal, decided 2026-04-28.
  if (durationChanged || formatChanged) {
    const negotiatedClearData: Record<string, null> = {};
    if (durationChanged) negotiatedClearData.negotiatedDuration = null;
    if (formatChanged) negotiatedClearData.negotiatedFormat = null;
    await prisma.negotiationSession.updateMany({
      where: {
        link: { recurringWindowId: ruleId },
        status: { in: ["active", "pending"] },
      },
      data: negotiatedClearData as Parameters<typeof prisma.negotiationSession.updateMany>[0]["data"],
    });
  }
  // Propagate the new duration to the denormalized NegotiationSession.duration
  // snapshot so dashboard thread cards reflect the change immediately. Mirrors
  // the parallel fix in handleUpdateLinkRules (commit 505d3c6) for the
  // Office Hours edit surface — same gap, same fix.
  if (durationChanged) {
    await prisma.negotiationSession.updateMany({
      where: {
        link: { recurringWindowId: ruleId },
        status: { in: ["active", "pending"] },
      },
      data: { duration: parsed.durationMinutes },
    });
  }

  await invalidateSchedule(userId);
  invalidateBehaviorSnapshot(userId);

  return NextResponse.json({
    ok: true,
    ruleId,
    updatedAt: nowIso,
  });
}
