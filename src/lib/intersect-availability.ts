/**
 * intersectAvailability — shared bilateral availability helper.
 *
 * Used by:
 *   - The bookings module's `intersectAvailability` composer tool (PR4)
 *   - `bilateral-availability.ts:computeBilateralForSession` (via
 *     `kind: "via-freebusy-snapshot"` — same observable output)
 *
 * Per proposal `2026-05-02_book-time-with-bilateral-availability.md` §3.2.
 *
 * Privacy invariants (non-negotiable):
 *   - Never expose which party is the blocker when `mutuallyOpen: false`.
 *     The aggregate flag is the only crossing signal. Mirror of
 *     `bilateral-availability.ts:9-18`.
 *   - Dual-tz contract: localStart rendered in caller's tz ONLY.
 *     Other party's tz is NOT exposed.
 *
 * Scoring discipline (Rule 22 hard-rule a-bis):
 *   - Both sides' integer scores produced by `deriveEmittedScore` from
 *     `scoring-emit.ts`. No new score-mutation sites.
 */

import { prisma } from "@/lib/prisma";
import { getOrComputeSchedule } from "@/lib/calendar";
import { getUserTimezone, formatIsoWithOffset } from "@/lib/timezone";
import {
  deriveEmittedScore,
  deriveEmittedPreferred,
} from "@/lib/scoring-emit";
import type { LinkParameters } from "@/lib/scoring";
import { buildAgentSnapshot } from "@/lib/agent-snapshot";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OtherIdentity =
  | { kind: "ae-account"; userId: string; meetSlug: string }
  | { kind: "via-freebusy-snapshot"; sessionId: string }
  | { kind: "via-snapshot"; agentJsonUrl: string };

export interface PairedSlot {
  start: string;
  end: string;
  yourScore: number;
  theirScore: number | null;
  yourPreferred: boolean;
  theirPreferred: boolean;
  mutuallyOpen: boolean;
  localStart: string;
}

export interface IntersectAvailabilityOpts {
  callerUserId: string;
  other: OtherIdentity;
  intent?: {
    activity?: string;
    durationMinutes?: number;
    format?: "video" | "phone" | "in-person";
    dateRange?: { start: string; end: string };
  };
  limit?: number;
  now?: Date;
}

export interface IntersectAvailabilityResult {
  candidates: PairedSlot[];
  bilateral: boolean;
}

// ---------------------------------------------------------------------------
// Score bookability test (mirrors bilateral-availability.ts isBookable)
// ---------------------------------------------------------------------------

function isBookable(score: number): boolean {
  return score <= 1;
}

// ---------------------------------------------------------------------------
// Internal: freebusy snapshot path (via-freebusy-snapshot)
// ---------------------------------------------------------------------------

interface SnapshotBusy {
  start: string;
  end: string;
}

async function loadFreebusySnapshot(
  sessionId: string,
): Promise<SnapshotBusy[] | null> {
  try {
    const msg = await prisma.message.findFirst({
      where: {
        sessionId,
        role: "system",
        metadata: { path: ["kind"], equals: "guest_calendar_snapshot" },
      },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });
    if (!msg) return null;
    const meta = msg.metadata as Record<string, unknown> | null;
    if (!meta || typeof meta !== "object") return null;
    if (Array.isArray(meta.busy)) return meta.busy as SnapshotBusy[];
    return [];
  } catch (e) {
    console.warn("[intersect-availability] snapshot load failed", { sessionId, error: e });
    return null;
  }
}

function freebusyToOpenWindows(
  busy: SnapshotBusy[],
  windowStart: Date,
  windowEnd: Date,
): Set<string> {
  const busyDates = busy.map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
  const openSet = new Set<string>();
  const cursor = new Date(windowStart);
  cursor.setMinutes(Math.ceil(cursor.getMinutes() / 30) * 30, 0, 0);
  let count = 0;
  while (cursor < windowEnd && count < 2016) {
    const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
    const isBusy = busyDates.some(
      (b) => cursor < b.end && slotEnd > b.start,
    );
    if (!isBusy) {
      openSet.add(cursor.toISOString());
    }
    cursor.setMinutes(cursor.getMinutes() + 30);
    count++;
  }
  return openSet;
}

// ---------------------------------------------------------------------------
// Internal: AE-account path
// ---------------------------------------------------------------------------

interface OtherSideSlot {
  start: string;
  score: number;
  preferred: boolean;
}

async function loadOtherSideSlots(
  userId: string,
  meetSlug: string,
  opts: { dateRange?: { start: string; end: string } },
): Promise<OtherSideSlot[] | null> {
  const [otherUser, primaryLink] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, preferences: true },
    }),
    prisma.negotiationLink.findFirst({
      where: { userId, slug: meetSlug, type: "primary" },
    }),
  ]);

  if (!otherUser || !primaryLink) return null;

  const snapshot = await buildAgentSnapshot(primaryLink, otherUser, {
    dateRange: opts.dateRange,
    limit: 200,
  });

  if (!snapshot.slots || snapshot.slots.length === 0) return null;

  return snapshot.slots.map((s) => ({
    start: s.start,
    score: s.score,
    preferred: s.preferred ?? false,
  }));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function intersectAvailability(
  opts: IntersectAvailabilityOpts,
): Promise<IntersectAvailabilityResult> {
  const { callerUserId, other, intent } = opts;
  const limit = opts.limit ?? 5;
  const now = opts.now ?? new Date();

  if (other.kind === "via-snapshot") {
    throw new Error("validation_failed: via-snapshot (federated agent.json) is reserved for v2; not implemented in v1");
  }

  const callerSchedule = await getOrComputeSchedule(callerUserId).catch((e) => {
    console.warn("[intersect-availability] caller schedule load failed", { callerUserId, error: e });
    return null;
  });

  if (!callerSchedule || !callerSchedule.connected) {
    return { candidates: [], bilateral: false };
  }

  const callerUser = await prisma.user.findUnique({
    where: { id: callerUserId },
    select: { preferences: true, meetSlug: true },
  });
  const callerTz = getUserTimezone(
    (callerUser?.preferences as Record<string, unknown> | null) ?? null,
  );

  const windowStart = intent?.dateRange?.start
    ? new Date(intent.dateRange.start)
    : now;
  const windowEnd = intent?.dateRange?.end
    ? new Date(intent.dateRange.end)
    : new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  let callerRules: LinkParameters = {};
  try {
    const meetSlugVal = callerUser?.meetSlug;
    if (meetSlugVal) {
      const primaryLink = await prisma.negotiationLink.findFirst({
        where: { userId: callerUserId, slug: meetSlugVal, type: "primary" },
        select: { parameters: true },
      });
      if (primaryLink?.parameters) {
        callerRules = primaryLink.parameters as LinkParameters;
      }
    }
  } catch (e) {
    console.warn("[intersect-availability] caller rules load failed", e);
  }

  let otherByStart: Map<string, { score: number; preferred: boolean }> | null = null;
  let freebusyOpenSet: Set<string> | null = null;
  let bilateral = false;

  if (other.kind === "ae-account") {
    const otherSlots = await loadOtherSideSlots(other.userId, other.meetSlug, {
      dateRange: intent?.dateRange,
    });
    if (otherSlots) {
      otherByStart = new Map(
        otherSlots.map((s) => [s.start, { score: s.score, preferred: s.preferred }]),
      );
      bilateral = true;
    }
  } else {
    // via-freebusy-snapshot
    const busy = await loadFreebusySnapshot(other.sessionId);
    if (busy !== null) {
      freebusyOpenSet = freebusyToOpenWindows(busy, windowStart, windowEnd);
      bilateral = true;
    }
  }

  const candidates: PairedSlot[] = [];

  for (const slot of callerSchedule.slots) {
    const slotStart = new Date(slot.start);
    if (slotStart <= now) continue;
    if (slotStart < windowStart || slotStart >= windowEnd) continue;

    const yourScore = deriveEmittedScore(slot, callerRules, callerTz);
    const yourPreferred = deriveEmittedPreferred(slot, callerRules, callerTz);

    if (!isBookable(yourScore)) continue;

    const startIso = slot.start;
    const localStart = formatIsoWithOffset(slotStart, callerTz);

    if (otherByStart !== null) {
      const otherEntry = otherByStart.get(startIso);
      if (!otherEntry) continue;

      const theirScore = otherEntry.score;
      const theirPreferred = otherEntry.preferred;
      const mutuallyOpen = isBookable(theirScore);

      candidates.push({
        start: startIso,
        end: slot.end,
        yourScore,
        theirScore,
        yourPreferred,
        theirPreferred,
        mutuallyOpen,
        localStart,
      });
    } else if (freebusyOpenSet !== null) {
      const otherFree = freebusyOpenSet.has(startIso);
      if (!otherFree) continue;

      candidates.push({
        start: startIso,
        end: slot.end,
        yourScore,
        theirScore: null,
        yourPreferred,
        theirPreferred: false,
        mutuallyOpen: true,
        localStart,
      });
    } else {
      candidates.push({
        start: startIso,
        end: slot.end,
        yourScore,
        theirScore: null,
        yourPreferred,
        theirPreferred: false,
        mutuallyOpen: false,
        localStart,
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.mutuallyOpen !== b.mutuallyOpen) {
      return a.mutuallyOpen ? -1 : 1;
    }
    const aMin = a.theirScore !== null ? Math.min(a.yourScore, a.theirScore) : a.yourScore;
    const bMin = b.theirScore !== null ? Math.min(b.yourScore, b.theirScore) : b.yourScore;
    if (aMin !== bMin) return aMin - bMin;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });

  return {
    candidates: candidates.slice(0, limit),
    bilateral,
  };
}
