/**
 * Profile gap detectors — Proposal 3 ("Progressive Profiling", decided
 * 2026-04-21), §2.4.
 *
 * A "gap" is a host profile field that's missing or stale and that Envoy
 * can naturally surface during a turn where it's relevant. The detector
 * approach is CONTEXT INJECTION, not middleware or hard gates:
 *
 *   1. At channel-chat context build time, `computeProfileGaps(userId)`
 *      walks a closed list of gap checks against the host's preferences
 *      + a light BehaviorSnapshot.
 *   2. For each active gap, a non-imperative HINT string is produced
 *      describing the gap and authorizing the LLM to ask on a natural
 *      turn. The hint forbids silent writes — profile writes must
 *      reflect the host's explicit confirmation on the FOLLOWING turn.
 *   3. The chat route injects the hints into the system prompt. The LLM
 *      reads them, decides whether the current turn is a natural moment
 *      to surface the ask, and either weaves the ask into prose or
 *      skips it.
 *
 * Silent-write prevention (B1 fold — load-bearing): the hint voice
 * describes the gap and permits asking, but never authorizes writing a
 * value the host only mentioned in passing. The chat route's
 * context-injection block also carries a meta-rule reinforcing this.
 *
 * Persistent-un-asked tradeoff (N1 fold): the stateless design means a
 * gap can in principle sit indefinitely if the LLM never picks a
 * "natural" turn. Accepted for v1; 2-week telemetry check at >40%
 * threshold will trigger a follow-up nudge-ledger proposal.
 */

import { prisma } from "@/lib/prisma";
import { readProfileField } from "@/lib/profile-fields";
import type { UserPreferences } from "@/lib/scoring";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileGapId =
  | "phone"
  | "zoom_link"
  | "evenings_posture"
  | "duration_override_pattern";

/**
 * Minimal user shape the gap checks consume. Kept intentionally narrow so
 * the route-side computation doesn't need to load the full user record.
 */
export interface UserForGapCheck {
  id: string;
  preferences: UserPreferences | null;
}

/**
 * Behavioral aggregates used by trigger fns that need to look at recent
 * host activity. Each field is opt-in via the `cheap-precheck` contract
 * in `computeProfileGaps` — we only query Prisma for a snapshot when at
 * least one gap's field-level precondition is satisfied (N5 fold).
 */
export interface BehaviorSnapshot {
  durationOverrideCountLast30Days: number;
  mostCommonOverrideDuration: number | null;
  offeredEveningSlotInLast10Days: boolean;
}

export interface ProfileGap {
  id: ProfileGapId;
  hint: string;
}

interface GapSpec {
  id: ProfileGapId;
  /** Cheap precheck — only preferences, no DB. */
  precheck: (u: UserForGapCheck) => boolean;
  /** Final trigger — precheck + behavior snapshot. */
  trigger: (u: UserForGapCheck, behavior: BehaviorSnapshot) => boolean;
  /** Produces the hint string injected into the system prompt. */
  hint: (u: UserForGapCheck, behavior: BehaviorSnapshot) => string;
}

// ---------------------------------------------------------------------------
// GAPS — closed list. Hint text is non-imperative (B1 fold): describe the
// gap, permit asking on a natural turn, forbid saving values mentioned in
// passing, require explicit host confirmation on the FOLLOWING turn.
// ---------------------------------------------------------------------------

const GAPS: GapSpec[] = [
  {
    id: "phone",
    precheck: (u) => readProfileField(u.preferences, "phone") == null,
    trigger: (u) => readProfileField(u.preferences, "phone") == null,
    hint: () =>
      "The host has no phone number on file. If this turn drafts a phone meeting, you may naturally ask the host for their preferred number. Do not save any phone number mentioned in passing — wait for the host to explicitly confirm the value they want saved, then call `update_meeting_settings` on the following turn with their confirmed input.",
  },
  {
    id: "zoom_link",
    precheck: (u) => {
      const provider = readProfileField(u.preferences, "videoProvider");
      const link = readProfileField(u.preferences, "zoomLink");
      return provider === "zoom" && !link;
    },
    trigger: (u) => {
      const provider = readProfileField(u.preferences, "videoProvider");
      const link = readProfileField(u.preferences, "zoomLink");
      return provider === "zoom" && !link;
    },
    hint: () =>
      "The host's video provider is Zoom but no personal Zoom link is on file. If this turn drafts a Zoom meeting, you may naturally ask the host for their preferred Zoom link. Do not save any URL the host mentions in passing — wait for the host to explicitly confirm the link they want saved, then call `update_meeting_settings` on the following turn.",
  },
  {
    id: "evenings_posture",
    precheck: (u) => eveningsPostureOf(u) === undefined,
    trigger: (u, behavior) =>
      eveningsPostureOf(u) === undefined && behavior.offeredEveningSlotInLast10Days,
    hint: () =>
      "The host has no evenings-posture preference set, and Envoy has offered an evening slot recently. If this turn surfaces an evening slot or the host expresses a preference about evenings, you may naturally ask whether evenings should be protected, open, or VIP-only. Do not infer a posture from a passing comment — wait for the host to explicitly confirm, then call `update_business_hours` or `update_availability_rule` on the following turn.",
  },
  {
    id: "duration_override_pattern",
    precheck: () => true, // always behavior-bound, no cheap skip available
    trigger: (u, behavior) =>
      behavior.durationOverrideCountLast30Days >= 10 &&
      behavior.mostCommonOverrideDuration !== null &&
      behavior.mostCommonOverrideDuration !== (readProfileField(u.preferences, "defaultDuration") ?? 30),
    hint: (u, behavior) => {
      const currentDefault = readProfileField(u.preferences, "defaultDuration") ?? 30;
      const mostCommon = behavior.mostCommonOverrideDuration;
      return `The host has overridden the default meeting duration ${behavior.durationOverrideCountLast30Days} times in the last 30 days, usually to ${mostCommon} minutes. Their current default is ${currentDefault}. If this turn touches meeting length, you may naturally offer to update the default. Do not change the default silently — wait for the host to explicitly confirm, then call \`update_meeting_settings\` on the following turn.`;
    },
  },
];

// eveningsPosture is not yet a first-class field on UserPreferences — it's
// written loosely by the tuner under `explicit.*`. Read it via an indexed
// access so we don't have to touch scoring.ts for a soft signal. When the
// posture field graduates to a typed field, swap this for `readProfileField`.
function eveningsPostureOf(u: UserForGapCheck): string | undefined {
  const explicit = u.preferences?.explicit as Record<string, unknown> | undefined;
  const value = explicit?.eveningsPosture;
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// BehaviorSnapshot cache — module-scope, 5-min TTL (N5 fold).
// ---------------------------------------------------------------------------

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const snapshotCache = new Map<string, { snapshot: BehaviorSnapshot; expires: number }>();

/**
 * Invalidate the cached BehaviorSnapshot for a user. Called after any
 * action that would materially change what a detector sees — profile
 * writes, rule writes, link creates.
 */
export function invalidateBehaviorSnapshot(userId: string): void {
  snapshotCache.delete(userId);
}

async function loadBehaviorSnapshot(userId: string): Promise<BehaviorSnapshot> {
  const cached = snapshotCache.get(userId);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.snapshot;

  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);

  const [links, recentProposals] = await Promise.all([
    prisma.negotiationLink.findMany({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
      select: { parameters: true },
      take: 200,
    }),
    prisma.proposal.findMany({
      where: {
        session: { hostId: userId },
        createdAt: { gte: tenDaysAgo },
        dateTime: { not: null },
      },
      select: { dateTime: true },
      take: 100,
    }),
  ]);

  // Duration override counting: a link with `rules.durationMinutes` set
  // counts as one override. Tally per-value frequency.
  const durationCounts = new Map<number, number>();
  for (const link of links) {
    const rules = (link.parameters as Record<string, unknown> | null) ?? null;
    const dur = rules && typeof rules.durationMinutes === "number" ? (rules.durationMinutes as number) : null;
    if (dur != null) {
      durationCounts.set(dur, (durationCounts.get(dur) ?? 0) + 1);
    }
  }
  const durationOverrideCountLast30Days = Array.from(durationCounts.values()).reduce(
    (sum, v) => sum + v,
    0,
  );
  let mostCommonOverrideDuration: number | null = null;
  let mostCommonCount = 0;
  for (const [dur, count] of Array.from(durationCounts.entries())) {
    if (count > mostCommonCount) {
      mostCommonCount = count;
      mostCommonOverrideDuration = dur;
    }
  }

  // Evening slot detection: any Proposal whose UTC hour corresponds to
  // evening host-local (18:00–23:59 in any common US tz = roughly 22:00
  // UTC – 08:00 UTC). Approximate by design — the gap only needs "has
  // Envoy surfaced an evening option lately?", not a strict count.
  let offeredEveningSlotInLast10Days = false;
  for (const p of recentProposals) {
    if (!p.dateTime) continue;
    const hourUtc = p.dateTime.getUTCHours();
    if (hourUtc >= 22 || hourUtc < 8) {
      offeredEveningSlotInLast10Days = true;
      break;
    }
  }

  const snapshot: BehaviorSnapshot = {
    durationOverrideCountLast30Days,
    mostCommonOverrideDuration,
    offeredEveningSlotInLast10Days,
  };
  snapshotCache.set(userId, { snapshot, expires: now + SNAPSHOT_TTL_MS });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the list of active profile gaps for a user. Always does a cheap
 * field-level precheck first; only loads the behavior snapshot (which hits
 * the DB) when at least one gap's precheck fires AND at least one gap in
 * the set is behavior-bound.
 *
 * Returns an empty array when no gaps are active. Callers inject the hints
 * into the LLM system prompt under a "Profile gaps:" block.
 */
export async function computeProfileGaps(userId: string): Promise<ProfileGap[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, preferences: true },
  });
  if (!user) return [];
  const userForCheck: UserForGapCheck = {
    id: user.id,
    preferences: user.preferences as UserPreferences | null,
  };

  // Cheap precheck — no behavior snapshot yet.
  const candidateGaps = GAPS.filter((g) => g.precheck(userForCheck));
  if (candidateGaps.length === 0) return [];

  // If every candidate can be decided on prefs alone AND none of them
  // reference behavior in their triggers, skip the DB query.
  const behaviorBoundIds = new Set<ProfileGapId>([
    "evenings_posture",
    "duration_override_pattern",
  ]);
  const needsBehavior = candidateGaps.some((g) => behaviorBoundIds.has(g.id));
  const behavior: BehaviorSnapshot = needsBehavior
    ? await loadBehaviorSnapshot(userId)
    : {
        durationOverrideCountLast30Days: 0,
        mostCommonOverrideDuration: null,
        offeredEveningSlotInLast10Days: false,
      };

  const active: ProfileGap[] = [];
  for (const gap of candidateGaps) {
    if (!gap.trigger(userForCheck, behavior)) continue;
    active.push({ id: gap.id, hint: gap.hint(userForCheck, behavior) });
  }
  return active;
}
