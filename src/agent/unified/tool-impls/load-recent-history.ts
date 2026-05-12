import { prisma } from "@/lib/prisma";

type LoadRecentHistoryResult = {
  turns: Array<{
    role: "user" | "envoy";
    content: string;
    createdAt: string;
    ageMinutes: number;
  }>;
  overflow: number;
  note: string;
};

/**
 * Returns recent ChannelMessage rows for the host-channel UA scope.
 *
 * Progressive context loading (2026-05-12): the runner preloads only the
 * last 2 turns into the prompt. When the model encounters a reference it
 * can't resolve from those 2 turns ("the meeting from earlier today",
 * "the Wednesday rule I set up"), it calls this tool to fetch more.
 *
 * Both filters can be supplied:
 *   - `count` — how many turns back to load (max 20). Defaults to 5 when
 *     `sinceMinutesAgo` is also omitted.
 *   - `sinceMinutesAgo` — only load turns within the last N minutes.
 *     Loose pairing with the staleness threshold in `runner.ts` —
 *     callers can intentionally fetch older context when they need it.
 *
 * When both are supplied, the tighter constraint wins (intersection).
 *
 * `MAX_TURNS_HARD_CAP` (20) caps the query regardless to bound input cost.
 */
const DEFAULT_COUNT = 5;
const MAX_TURNS_HARD_CAP = 20;

export async function loadRecentHistory(
  channelId: string,
  args: { count?: number; sinceMinutesAgo?: number },
): Promise<LoadRecentHistoryResult> {
  // Resolve effective count. If neither arg provided, fall back to default.
  // If only sinceMinutesAgo provided, allow up to MAX_TURNS_HARD_CAP within
  // that window. If only count provided, use it (capped).
  const requestedCount =
    typeof args.count === "number" && args.count > 0
      ? Math.min(args.count, MAX_TURNS_HARD_CAP)
      : typeof args.sinceMinutesAgo === "number"
        ? MAX_TURNS_HARD_CAP
        : DEFAULT_COUNT;

  // Time floor — undefined means "no time filter."
  const sinceDate =
    typeof args.sinceMinutesAgo === "number" && args.sinceMinutesAgo > 0
      ? new Date(Date.now() - args.sinceMinutesAgo * 60 * 1000)
      : undefined;

  const rows = await prisma.channelMessage.findMany({
    where: {
      channelId,
      ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: requestedCount,
    select: { role: true, content: true, createdAt: true },
  });

  const now = Date.now();
  const turns = rows
    .reverse() // oldest-first for natural reading
    .map((r) => {
      const ageMinutes = Math.round((now - r.createdAt.getTime()) / 60000);
      return {
        role: r.role === "envoy" ? ("envoy" as const) : ("user" as const),
        content: r.content,
        createdAt: r.createdAt.toISOString(),
        ageMinutes,
      };
    });

  // Count total matching the time filter for overflow signal.
  const totalMatching = sinceDate
    ? await prisma.channelMessage.count({
        where: { channelId, createdAt: { gte: sinceDate } },
      })
    : await prisma.channelMessage.count({ where: { channelId } });
  const overflow = Math.max(0, totalMatching - turns.length);

  const filterDesc = sinceDate
    ? `${turns.length} turn(s) in last ${args.sinceMinutesAgo} min`
    : `${turns.length} turn(s) (last ${requestedCount})`;
  const note =
    overflow > 0
      ? `${filterDesc} returned; ${overflow} older turn(s) available.`
      : `${filterDesc} returned.`;

  return { turns, overflow, note };
}
