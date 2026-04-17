import { prisma } from "@/lib/prisma";
import type {
  DevStatsFailure,
  DevStatsFormatBreakdown,
  DevStatsParams,
} from "./dev-stats";

/**
 * Gather the daily counts that feed `buildDevStatsEmail`.
 *
 * Pure aggregation: runs independent queries in parallel, normalizes the
 * shapes, sorts the two breakdowns by count desc. No side effects, no
 * formatting — those live in `dev-stats.ts`.
 */
export async function gatherDevStats(
  windowStart: Date,
  windowEnd: Date,
): Promise<DevStatsParams> {
  const [
    newUsers,
    sessionsCreated,
    sessionsConfirmed,
    sessionsCancelled,
    sessionsExpired,
    sessionsEscalated,
    agreedSessions,
    failedEffects,
  ] = await Promise.all([
    prisma.user.count({
      where: { createdAt: { gte: windowStart, lt: windowEnd } },
    }),
    prisma.negotiationSession.count({
      where: { createdAt: { gte: windowStart, lt: windowEnd } },
    }),
    // Sessions whose terminal transition to "agreed" fell in the window.
    // NegotiationSession lacks a dedicated `agreedAt`; updatedAt is the best
    // proxy since the confirm route's CAS is the last write that flips status.
    prisma.negotiationSession.count({
      where: {
        status: "agreed",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    }),
    // No "cancelled" status exists — cancellations set archived=true on a
    // previously-agreed session. Approximate by in-window archived flips.
    prisma.negotiationSession.count({
      where: {
        archived: true,
        status: "agreed",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    }),
    prisma.negotiationSession.count({
      where: {
        status: "expired",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    }),
    prisma.negotiationSession.count({
      where: {
        status: "escalated",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    }),
    prisma.negotiationSession.groupBy({
      by: ["agreedFormat"],
      where: {
        status: "agreed",
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
      _count: { _all: true },
    }),
    prisma.sideEffectLog.groupBy({
      by: ["kind"],
      where: {
        status: "failed",
        createdAt: { gte: windowStart, lt: windowEnd },
      },
      _count: { _all: true },
    }),
  ]);

  const formatBreakdown: DevStatsFormatBreakdown[] = agreedSessions
    .map((row) => ({
      format: row.agreedFormat ?? "(unspecified)",
      count: row._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  const failures: DevStatsFailure[] = failedEffects
    .map((row) => ({ kind: row.kind, count: row._count._all }))
    .sort((a, b) => b.count - a.count);

  const totalFailures = failures.reduce((sum, f) => sum + f.count, 0);

  return {
    windowStart,
    windowEnd,
    newUsers,
    sessionsCreated,
    sessionsConfirmed,
    sessionsCancelled,
    sessionsExpired,
    sessionsEscalated,
    formatBreakdown,
    failures,
    totalFailures,
  };
}
