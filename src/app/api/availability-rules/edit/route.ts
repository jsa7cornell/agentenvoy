/**
 * Office Hours edit endpoint (Phase 1 PR 7).
 *
 * Companion to `confirm/route.ts` — that one creates a new Office Hours rule
 * from a chat-flow proposal; this one updates an existing rule's editable
 * parameters from the Event Links sheet's Edit dialog. Both writers must
 * keep shape parity with `handleUpdateAvailabilityRule` (operation:
 * "modify", action: "office_hours") at `app/src/agent/actions.ts`.
 *
 * Defense-in-depth shape:
 *   1. Authn — host must own the rule (it lives on `User.preferences.explicit
 *      .structuredRules[]`, so ownership is implicit).
 *   2. Body shape — validated against the OfficeHoursProposal contract
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
  type AvailabilityRule,
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
      | AvailabilityRule[]
      | undefined) ?? [];
  const generalLinkName =
    typeof explicit.generalLinkName === "string" ? explicit.generalLinkName : undefined;

  const target = existingRules.find((r) => r.id === ruleId);
  if (!target) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }
  if (target.action !== "office_hours" || !target.officeHours) {
    return NextResponse.json(
      { error: "Rule is not an Office Hours rule" },
      { status: 400 },
    );
  }

  // Per-host name uniqueness — same guard as confirm/route.ts and
  // handleUpdateAvailabilityRule. Excludes the rule we're editing.
  const taken = new Set<string>();
  for (const r of existingRules) {
    if (r.id === ruleId) continue;
    if (r.action !== "office_hours" || !r.officeHours) continue;
    const n = (r.officeHours.name ?? r.officeHours.title ?? "").trim();
    if (n) taken.add(normalizeLinkName(n));
  }
  taken.add(
    normalizeLinkName(
      generalLinkName && generalLinkName.trim() ? generalLinkName : "General",
    ),
  );
  if (taken.has(normalizeLinkName(parsed.title))) {
    return NextResponse.json(
      { error: `You already have a link named "${parsed.title}". Pick a different name.` },
      { status: 409 },
    );
  }

  const nowIso = new Date().toISOString();
  const updated: AvailabilityRule = {
    ...target,
    timeStart: parsed.timeStart,
    timeEnd: parsed.timeEnd,
    daysOfWeek: parsed.daysOfWeek,
    effectiveDate: parsed.effectiveDate,
    expiryDate: parsed.expiryDate,
    officeHours: {
      // Preserve immutable fields — linkSlug and linkCode are permanent.
      linkSlug: target.officeHours.linkSlug,
      linkCode: target.officeHours.linkCode,
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

  await invalidateSchedule(userId);
  invalidateBehaviorSnapshot(userId);

  return NextResponse.json({
    ok: true,
    ruleId,
    updatedAt: nowIso,
  });
}
