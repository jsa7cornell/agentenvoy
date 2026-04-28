/**
 * Narrow reader + deleter for the block-type structured rules that back
 * the blocks chip at the top of the feed (proposal
 * `2026-04-23_primary-link-config-convergence` §3.2 + staging V2).
 *
 * Scope intentionally small:
 *   - GET — returns the subset of `preferences.explicit.structuredRules`
 *           where action="block" (with expiry cleanup applied).
 *   - DELETE — remove a single block by ruleId, invalidates the cached
 *              schedule. Destructive; requires confirmation in the UI
 *              per proposal P2 (confirmation card gates block deletion).
 *
 * Creation lives elsewhere — /api/tuner/parse-rule (LLM freetext) or
 * /api/tuner/preferences (structured). Creating blocks through chat is
 * the canonical path; this endpoint doesn't duplicate it.
 *
 * Merges into /api/me/scheduling-state when that endpoint ships.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSchedule } from "@/lib/calendar";
import { expireRules } from "@/lib/availability-rules";
import type { AvailabilityPreference } from "@/lib/availability-rules";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

function selectBlocks(rules: AvailabilityPreference[]): AvailabilityPreference[] {
  return rules.filter((r) => r.action === "block" && r.status !== "expired");
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const explicit = prefs.explicit ?? {};
  const rules =
    ((explicit as { structuredRules?: AvailabilityPreference[] }).structuredRules ??
      []) as AvailabilityPreference[];

  // Apply expiry cleanup on read so stale rules don't linger in the UI.
  const { rules: cleaned } = expireRules(rules);

  return NextResponse.json({ blocks: selectBlocks(cleaned) });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | { ruleId?: string }
    | null;
  if (!body?.ruleId || typeof body.ruleId !== "string") {
    return NextResponse.json(
      { error: "ruleId required" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { preferences: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const explicit = prefs.explicit ?? {};
  const rules =
    ((explicit as { structuredRules?: AvailabilityPreference[] }).structuredRules ??
      []) as AvailabilityPreference[];

  const target = rules.find((r) => r.id === body.ruleId);
  if (!target) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }
  if (target.action !== "block") {
    // Safety: this endpoint only deletes blocks, never other rule actions.
    // Callers wanting broader deletion use /api/tuner/preferences.
    return NextResponse.json(
      { error: "Only block-type rules can be deleted here" },
      { status: 400 },
    );
  }

  const nextRules = rules.filter((r) => r.id !== body.ruleId);
  const nextExplicit = { ...explicit, structuredRules: nextRules };
  const nextPrefs: UserPreferences = { ...prefs, explicit: nextExplicit };

  await prisma.user.update({
    where: { id: session.user.id },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });
  // Removing a block expands availability — schedule must recompile.
  await invalidateSchedule(session.user.id);

  return NextResponse.json({ ok: true, blocks: selectBlocks(nextRules) });
}
