/**
 * /admin/feedback — list of user-submitted FeedbackReports (F3 + F5).
 *
 * Each row is a report with user, text, attached slices, resolved flag.
 * Opening a detail view is audited via logAdminAccess (action: "view").
 * Reading the list itself is audited as action: "list".
 */
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SearchParams {
  range?: string;
  resolved?: string; // "open" | "resolved" | "all" — default "open"
  source?: string; // "all" | "dashboard" | "deal-room" — default "all"
}

function parseRange(range: string | undefined): { since: Date; label: string } {
  const now = Date.now();
  switch (range) {
    case "24h":
      return { since: new Date(now - 24 * 3600 * 1000), label: "24h" };
    case "30d":
      return { since: new Date(now - 30 * 24 * 3600 * 1000), label: "30d" };
    case "all":
      return { since: new Date(0), label: "all" };
    case "7d":
    default:
      return { since: new Date(now - 7 * 24 * 3600 * 1000), label: "7d" };
  }
}

function parseResolved(v: string | undefined): "open" | "resolved" | "all" {
  return v === "resolved" || v === "all" ? v : "open";
}

type SourceFilter = "all" | "dashboard" | "deal-room";
function parseSource(v: string | undefined): SourceFilter {
  return v === "dashboard" || v === "deal-room" ? v : "all";
}

type ChecklistLike = Record<string, unknown> | null;

function slicesFromChecklist(c: ChecklistLike): string[] {
  if (!c || typeof c !== "object") return [];
  const out: string[] = [];
  if (c.messages) out.push("msgs");
  if (c.sessions) out.push("sess");
  if (c.calendar) out.push("cal");
  if (c.errors) out.push("errs");
  if (c.console) out.push("cons");
  return out;
}

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const admin = await requireAdminContext("/admin/feedback");
  const params = await searchParams;
  const { since, label } = parseRange(params.range);
  const resolvedFilter = parseResolved(params.resolved);
  const sourceFilter = parseSource(params.source);

  await logAdminAccess({
    adminId: admin.id,
    path: "/admin/feedback",
    action: "list",
    targetUserId: null,
    context: { range: label, resolved: resolvedFilter, source: sourceFilter },
  });

  const rows = await prisma.feedbackReport.findMany({
    where: {
      createdAt: { gte: since },
      ...(resolvedFilter === "all" ? {} : { resolved: resolvedFilter === "resolved" }),
      ...(sourceFilter === "deal-room"
        ? { url: { contains: "/meet/" } }
        : sourceFilter === "dashboard"
          ? { NOT: { url: { contains: "/meet/" } } }
          : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      createdAt: true,
      resolved: true,
      userText: true,
      userId: true,
      checklistState: true,
      url: true,
      filedByGuest: true,
      guestName: true,
    },
  });

  const userIds = Array.from(new Set(rows.map((r) => r.userId)));
  const users =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true },
        });
  const emailById = new Map(users.map((u) => [u.id, u.email ?? u.id]));

  return (
    <main className="mx-auto max-w-6xl p-6 font-mono text-sm">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Admin · Feedback</h1>
        <p className="text-zinc-500">
          Signed in as <code>{admin.email}</code> · Range: <code>{label}</code> · Showing:{" "}
          <code>{resolvedFilter}</code>
        </p>
      </header>

      <section className="mb-4 flex flex-wrap gap-2 text-xs">
        <RangeLink label="24h" current={label} target="24h" resolved={resolvedFilter} source={sourceFilter} />
        <RangeLink label="7d" current={label} target="7d" resolved={resolvedFilter} source={sourceFilter} />
        <RangeLink label="30d" current={label} target="30d" resolved={resolvedFilter} source={sourceFilter} />
        <RangeLink label="all" current={label} target="all" resolved={resolvedFilter} source={sourceFilter} />
        <span className="mx-2 text-zinc-600">·</span>
        <ResolvedLink label="open" current={resolvedFilter} target="open" range={label} source={sourceFilter} />
        <ResolvedLink label="resolved" current={resolvedFilter} target="resolved" range={label} source={sourceFilter} />
        <ResolvedLink label="all" current={resolvedFilter} target="all" range={label} source={sourceFilter} />
        <span className="mx-2 text-zinc-600">·</span>
        <SourceLink label="all" current={sourceFilter} target="all" range={label} resolved={resolvedFilter} />
        <SourceLink label="dashboard" current={sourceFilter} target="dashboard" range={label} resolved={resolvedFilter} />
        <SourceLink label="deal-room" current={sourceFilter} target="deal-room" range={label} resolved={resolvedFilter} />
      </section>

      {rows.length === 0 ? (
        <p className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-zinc-400">
          No {resolvedFilter === "all" ? "" : `${resolvedFilter} `}reports in the last {label}.
        </p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-zinc-700 text-left">
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">From</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Slices</th>
              <th className="py-2 pr-4">Text</th>
              <th className="py-2 pr-4"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const hostEmail = emailById.get(r.userId) ?? r.userId;
              const slices = slicesFromChecklist(r.checklistState as ChecklistLike);
              const text = r.userText ?? "";
              const preview = text
                ? text.length > 90
                  ? `${text.slice(0, 90)}…`
                  : text
                : <span className="text-zinc-600 italic">(no text)</span>;
              return (
                <tr key={r.id} className="border-b border-zinc-800 align-top">
                  <td className="py-2 pr-4 whitespace-nowrap text-zinc-500">
                    {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-300">
                        {r.filedByGuest
                          ? (r.guestName || "Guest (unknown)")
                          : hostEmail}
                      </span>
                      {r.filedByGuest && (
                        <span
                          className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-300"
                          title={`Host: ${hostEmail}`}
                        >
                          guest
                        </span>
                      )}
                      {r.url?.includes("/meet/") && !r.filedByGuest && (
                        <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-300">
                          deal-room
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    {r.resolved ? (
                      <span className="text-emerald-400">resolved</span>
                    ) : (
                      <span className="text-amber-400">open</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-zinc-400">
                    {slices.length === 0 ? "—" : slices.join(", ")}
                  </td>
                  <td className="py-2 pr-4 text-zinc-200">{preview}</td>
                  <td className="py-2 pr-4">
                    <Link
                      href={`/admin/feedback/${r.id}`}
                      className="text-sky-400 hover:underline"
                    >
                      open →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <footer className="mt-8 text-xs text-zinc-500">
        <p>
          Showing up to 200 rows · Return to{" "}
          <Link href="/admin" className="text-sky-400 hover:underline">
            /admin
          </Link>
          .
        </p>
      </footer>
    </main>
  );
}

function filterPillClass(active: boolean): string {
  return `rounded border px-2 py-0.5 ${
    active
      ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
      : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
  }`;
}

function RangeLink({
  label,
  current,
  target,
  resolved,
  source,
}: {
  label: string;
  current: string;
  target: string;
  resolved: string;
  source: string;
}) {
  const qs = new URLSearchParams();
  qs.set("range", target);
  qs.set("resolved", resolved);
  qs.set("source", source);
  return (
    <Link
      href={`/admin/feedback?${qs.toString()}`}
      className={filterPillClass(current === target)}
    >
      {label}
    </Link>
  );
}

function ResolvedLink({
  label,
  current,
  target,
  range,
  source,
}: {
  label: string;
  current: string;
  target: string;
  range: string;
  source: string;
}) {
  const qs = new URLSearchParams();
  qs.set("range", range);
  qs.set("resolved", target);
  qs.set("source", source);
  return (
    <Link
      href={`/admin/feedback?${qs.toString()}`}
      className={filterPillClass(current === target)}
    >
      {label}
    </Link>
  );
}

function SourceLink({
  label,
  current,
  target,
  range,
  resolved,
}: {
  label: string;
  current: string;
  target: string;
  range: string;
  resolved: string;
}) {
  const qs = new URLSearchParams();
  qs.set("range", range);
  qs.set("resolved", resolved);
  qs.set("source", target);
  return (
    <Link
      href={`/admin/feedback?${qs.toString()}`}
      className={filterPillClass(current === target)}
    >
      {label}
    </Link>
  );
}
