/**
 * /admin/feedback/patterns — FB-5 aggregate failure-pattern dashboard.
 *
 * Groups FeedbackReport rows by FB-2 tag, counts per tag per week, links to
 * example reports. Shows "Tag some reports to see patterns" when <10 tagged
 * reports exist.
 *
 * Requires FB-2 tags to be populated. Only compositor_thumbs_down area
 * reports tend to carry tags; all tagged reports are shown regardless of area.
 */

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";
import { FEEDBACK_TAGS, type FeedbackTag } from "@/lib/feedback/schema";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MIN_TAGGED_REPORTS = 10;

type WeekBucket = { week: string; count: number };
type TagStats = {
  tag: FeedbackTag;
  total: number;
  weeks: WeekBucket[];
  exampleIds: string[];
};

async function fetchPatternStats(): Promise<{ stats: TagStats[]; totalTagged: number }> {
  // All reports with at least one tag, last 90 days.
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const reports = await prisma.feedbackReport.findMany({
    where: {
      createdAt: { gte: since },
      // Postgres: tags is text[]; find non-empty arrays. Raw filter here.
    },
    select: { id: true, tags: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const tagged = reports.filter((r) => r.tags && r.tags.length > 0);
  if (tagged.length === 0) return { stats: [], totalTagged: 0 };

  const tagMap = new Map<FeedbackTag, { weeks: Map<string, number>; ids: string[] }>();

  for (const r of tagged) {
    for (const tag of r.tags as string[]) {
      if (!FEEDBACK_TAGS.includes(tag as FeedbackTag)) continue;
      const t = tag as FeedbackTag;
      if (!tagMap.has(t)) tagMap.set(t, { weeks: new Map(), ids: [] });
      const entry = tagMap.get(t)!;

      // ISO week bucket: YYYY-WNN
      const d = r.createdAt;
      const weekNum = getISOWeek(d);
      const weekKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
      entry.weeks.set(weekKey, (entry.weeks.get(weekKey) ?? 0) + 1);

      if (entry.ids.length < 3) entry.ids.push(r.id);
    }
  }

  const stats: TagStats[] = Array.from(tagMap.entries())
    .map(([tag, { weeks, ids }]) => {
      const total = Array.from(weeks.values()).reduce((s, n) => s + n, 0);
      const weeksSorted: WeekBucket[] = Array.from(weeks.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 8)
        .map(([week, count]) => ({ week, count }));
      return { tag, total, weeks: weeksSorted, exampleIds: ids };
    })
    .sort((a, b) => b.total - a.total);

  return { stats, totalTagged: tagged.length };
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

const TAG_LABELS: Record<FeedbackTag, string> = {
  "over-asks": "Asked for info it already had",
  "echoed-reasoning": "Showed internal reasoning",
  "too-wordy": "Too long / verbose",
  "wrong-tool": "Used wrong action / tool",
  "hallucinated-success": "Claimed it did something it didn't",
  "missed-multi-option": "Should have offered more options",
};

export default async function FeedbackPatternsPage() {
  const admin = await requireAdminContext("/admin/feedback/patterns");

  await logAdminAccess({
    adminId: admin.id,
    path: "/admin/feedback/patterns",
    action: "list",
    targetUserId: null,
    context: {},
  });

  const { stats, totalTagged } = await fetchPatternStats();

  return (
    <main className="mx-auto max-w-4xl p-6 font-mono text-sm">
      <header className="mb-6">
        <Link href="/admin/feedback" className="text-xs text-sky-400 hover:underline">
          &larr; /admin/feedback
        </Link>
        <div className="mt-2">
          <h1 className="text-xl font-bold">Failure patterns</h1>
          <p className="mt-1 text-xs text-zinc-500">
            Tags from 👎 reports · last 90 days · {totalTagged} tagged report{totalTagged === 1 ? "" : "s"}
          </p>
        </div>
      </header>

      {totalTagged < MIN_TAGGED_REPORTS ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center">
          <p className="text-zinc-400 text-sm">Tag some reports to see patterns here.</p>
          <p className="mt-1 text-xs text-zinc-600">
            {totalTagged > 0
              ? `${totalTagged} tagged so far — need ${MIN_TAGGED_REPORTS} before patterns are meaningful.`
              : "Use the 👎 checkbox row on host messages to tag failure modes."}
          </p>
          <Link
            href="/admin/feedback?area=composer_thumbs_down"
            className="mt-4 inline-block text-xs text-sky-400 hover:underline"
          >
            Open feedback queue →
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {stats.map(({ tag, total, weeks, exampleIds }) => {
            const maxWeekCount = Math.max(...weeks.map((w) => w.count), 1);
            return (
              <section key={tag} className="rounded-lg border border-white/10 bg-zinc-900/50 p-5">
                <div className="mb-3 flex items-start justify-between gap-4">
                  <div>
                    <p className="font-semibold text-zinc-100">{TAG_LABELS[tag]}</p>
                    <p className="text-xs text-zinc-500 font-mono">{tag}</p>
                  </div>
                  <span className="shrink-0 text-2xl font-bold text-zinc-200">{total}</span>
                </div>

                {weeks.length > 0 && (
                  <div className="mb-3">
                    <p className="mb-1.5 text-[10px] text-zinc-600 uppercase tracking-wide">Per week (most recent first)</p>
                    <div className="flex items-end gap-1.5 h-8">
                      {weeks.map(({ week, count }) => (
                        <div
                          key={week}
                          title={`${week}: ${count}`}
                          className="flex-1 rounded-sm bg-red-500/50"
                          style={{ height: `${Math.max(8, (count / maxWeekCount) * 32)}px` }}
                        />
                      ))}
                    </div>
                    <div className="flex gap-1.5 mt-0.5">
                      {weeks.map(({ week, count }) => (
                        <div key={week} className="flex-1 text-center text-[9px] text-zinc-600">
                          {count}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {exampleIds.length > 0 && (
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="text-zinc-600">Examples:</span>
                    {exampleIds.map((id) => (
                      <Link
                        key={id}
                        href={`/admin/feedback/${id}`}
                        className="font-mono text-sky-400 hover:underline"
                      >
                        {id.slice(-8)}
                      </Link>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <footer className="mt-8 text-xs text-zinc-500">
        <Link href="/admin/feedback" className="text-sky-400 hover:underline">
          /admin/feedback
        </Link>
        {" · "}
        <Link href="/admin" className="text-sky-400 hover:underline">
          /admin
        </Link>
      </footer>
    </main>
  );
}
