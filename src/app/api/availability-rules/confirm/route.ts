/**
 * Office Hours create flow — confirmation endpoint (Phase 1 PR 5).
 *
 * Companion to the `rule_proposal` system message persisted by
 * `dispatch-handler.ts` when an LLM-emitted `update_availability_rule`
 * action with `params.rule.action === "bookable"` (or legacy `"office_hours"`)
 * and `operation === "add"` is intercepted. The desktop card / mobile sheet
 * surfaces the prefilled fields; clicking "Looks good" POSTs here.
 *
 * Defense-in-depth shape:
 *   1. Authn — host must own the channel that holds the proposal row.
 *   2. Body shape — validated against the BookableLinkProposal contract.
 *   3. Cross-check — the persisted proposal metadata must match the body
 *      on the *immutable* fields (`originalText`). The host CAN edit
 *      `title` / `format` / `durationMinutes` / `daysOfWeek` / `timeStart`
 *      / `timeEnd` / `effectiveDate` / `expiryDate` from the card before
 *      confirming — those edits are honored. But the host can't swap a
 *      proposal for a totally different one by tampering with the body.
 *
 * On success we write the rule to `User.preferences.explicit.structuredRules[]`
 * mirroring the shape produced by `handleUpdateAvailabilityRule` (operation:
 * "add", action: "bookable") at `app/src/agent/actions.ts:2401`. We do
 * NOT call into actions.ts directly — keeping the writer here is intentional
 * (Phase 1 scope: no mutations to actions.ts beyond what dispatch-handler
 * needs). When Phase 5 converges the composer surface, this endpoint can be
 * collapsed into the same writer. Until then, the two paths must keep
 * shape parity — see the per-field comments below.
 *
 * Idempotency: each successful confirm marks the proposal row's metadata
 * with `confirmed: true` so a double-tap doesn't double-write the rule.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCode } from "@/lib/utils";
import { invalidateSchedule } from "@/lib/calendar";
import { invalidateBehaviorSnapshot } from "@/lib/profile-gaps";
import {
  type AvailabilityPreference,
  normalizeLinkName,
} from "@/lib/availability-rules";
import type { UserPreferences } from "@/lib/scoring";
import type { Prisma } from "@prisma/client";

interface OfficeHoursProposalBody {
  originalText: string;
  title: string;
  format: "video" | "phone" | "in-person";
  durationMinutes: number;
  daysOfWeek: number[];
  timeStart: string;
  timeEnd: string;
  effectiveDate?: string;
  expiryDate?: string;
  /** Per-rule guest-flexibility opt-in. Both default false. Reusable-link
   *  guest-picks proposal, decided 2026-04-28. */
  guestPicks?: {
    format?: boolean;
    duration?: boolean;
  };
}

const VALID_FORMATS: ReadonlyArray<OfficeHoursProposalBody["format"]> = [
  "video",
  "phone",
  "in-person",
];
const VALID_DURATIONS = new Set([15, 20, 30, 45, 60, 90]);

function buildBookableLinkUrl(slug: string, code: string): string {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || "https://agentenvoy.ai";
  return `${origin}/meet/${slug}/${code}`;
}

function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}

function isValidISODate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseProposal(raw: unknown): OfficeHoursProposalBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "proposal must be an object" };
  const p = raw as Record<string, unknown>;
  if (typeof p.originalText !== "string") return { error: "originalText must be a string" };
  if (typeof p.title !== "string" || !p.title.trim()) {
    return { error: "title is required" };
  }
  if (!VALID_FORMATS.includes(p.format as OfficeHoursProposalBody["format"])) {
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
  // guestPicks: optional, both fields default false. Defensive parsing —
  // accept only booleans, ignore unknown shapes silently.
  const rawGuestPicks = p.guestPicks as Record<string, unknown> | undefined;
  const parsedGuestPicks =
    rawGuestPicks && typeof rawGuestPicks === "object"
      ? {
          ...(typeof rawGuestPicks.format === "boolean" ? { format: rawGuestPicks.format } : {}),
          ...(typeof rawGuestPicks.duration === "boolean" ? { duration: rawGuestPicks.duration } : {}),
        }
      : undefined;
  return {
    originalText: p.originalText,
    title: p.title.trim(),
    format: p.format as OfficeHoursProposalBody["format"],
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

  const proposalMessageId = body.proposalMessageId;
  if (typeof proposalMessageId !== "string" || !proposalMessageId) {
    return NextResponse.json(
      { error: "proposalMessageId is required" },
      { status: 400 },
    );
  }

  const parsed = parseProposal(body.proposal);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Authn: load the proposal row + ensure it belongs to a channel owned by
  // the calling user. Without this check, a host could confirm somebody
  // else's proposal by guessing the message id.
  const proposalMsg = await prisma.channelMessage.findUnique({
    where: { id: proposalMessageId },
    select: {
      id: true,
      role: true,
      metadata: true,
      channel: { select: { userId: true } },
    },
  });
  if (!proposalMsg) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }
  if (proposalMsg.channel.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (proposalMsg.role !== "system") {
    return NextResponse.json({ error: "Not a proposal row" }, { status: 400 });
  }
  const meta = (proposalMsg.metadata ?? {}) as Record<string, unknown>;
  if (meta.kind !== "rule_proposal") {
    return NextResponse.json({ error: "Not a rule_proposal" }, { status: 400 });
  }
  if (meta.confirmed === true) {
    return NextResponse.json({ error: "Already confirmed" }, { status: 409 });
  }
  const persistedProposal = (meta.proposal as Record<string, unknown> | undefined) ?? {};

  // Cross-check: the immutable field (originalText) must match what we
  // persisted. Editable fields (title / format / duration / days / times /
  // dates) are honored as the host's edits.
  if (
    typeof persistedProposal.originalText === "string" &&
    persistedProposal.originalText !== parsed.originalText
  ) {
    return NextResponse.json(
      { error: "Proposal mismatch — refresh and try again" },
      { status: 409 },
    );
  }

  // Load user prefs for the actual rule write — mirrors the shape produced
  // by handleUpdateAvailabilityRule (operation: "add", action: "bookable")
  // at app/src/agent/actions.ts:2401. Keep these two writers in sync.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true, meetSlug: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!user.meetSlug) {
    return NextResponse.json(
      {
        error:
          "Can't create an Office Hours link — your meeting slug isn't set up yet.",
      },
      { status: 400 },
    );
  }

  const prefs = (user.preferences as UserPreferences | null) ?? {};
  const explicit = { ...(prefs.explicit ?? {}) };
  const existingRules =
    ((explicit as Record<string, unknown>).structuredRules as
      | AvailabilityPreference[]
      | undefined) ?? [];
  const generalLinkName =
    typeof explicit.primaryLinkName === "string" ? explicit.primaryLinkName : undefined;

  // Per-host name uniqueness — same guard as handleUpdateAvailabilityRule.
  const taken = new Set<string>();
  for (const r of existingRules) {
    const bookableData = r.bookable;
    if (r.action !== "bookable" || !bookableData) continue;
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

  const newRuleId = `rule_${generateCode(8)}`;
  const linkCode = generateCode(8);
  const nowIso = new Date().toISOString();

  const rule: AvailabilityPreference = {
    id: newRuleId,
    originalText: parsed.originalText.trim() || "(no description)",
    type: "recurring",
    action: "bookable",
    timeStart: parsed.timeStart,
    timeEnd: parsed.timeEnd,
    daysOfWeek: parsed.daysOfWeek,
    effectiveDate: parsed.effectiveDate,
    expiryDate: parsed.expiryDate,
    bookable: {
      name: parsed.title,
      title: parsed.title,
      format: parsed.format,
      durationMinutes: parsed.durationMinutes,
      linkSlug: user.meetSlug,
      linkCode,
      ...(parsed.guestPicks ? { guestPicks: parsed.guestPicks } : {}),
    },
    status: "active",
    priority: 3,
    createdAt: nowIso,
  };

  const nextRules = [...existingRules, rule];
  (explicit as Record<string, unknown>).structuredRules = nextRules;
  const nextPrefs: UserPreferences = { ...prefs, explicit };

  // Atomic-ish: write the rule, then mark the proposal as confirmed so a
  // double-tap doesn't double-write.
  await prisma.user.update({
    where: { id: userId },
    data: { preferences: nextPrefs as unknown as Prisma.InputJsonValue },
  });
  await prisma.channelMessage.update({
    where: { id: proposalMessageId },
    data: {
      metadata: {
        ...meta,
        confirmed: true,
        confirmedAt: nowIso,
        ruleId: newRuleId,
      } as Prisma.InputJsonValue,
    },
  });

  // Append a confirmation row in the channel so the feed renders the
  // shipped Event Links update inline (matches mockups/mobile-v2.html §2
  // frame 3 and the item-20 confirmation contract).
  const linkUrl = buildBookableLinkUrl(user.meetSlug, linkCode);
  await prisma.channelMessage.create({
    data: {
      channelId: (await prisma.channel.findUnique({
        where: { userId },
        select: { id: true },
      }))!.id,
      role: "system",
      content: `✓ Created Office Hours link · ${parsed.title}`,
      metadata: {
        kind: "rule_confirmation",
        ruleId: newRuleId,
        title: parsed.title,
        linkUrl,
      } as Prisma.InputJsonValue,
    },
  });

  await invalidateSchedule(userId);
  invalidateBehaviorSnapshot(userId);

  return NextResponse.json({
    ok: true,
    ruleId: newRuleId,
    linkUrl,
  });
}
