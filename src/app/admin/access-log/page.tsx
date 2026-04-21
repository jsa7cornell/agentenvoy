/**
 * /admin/access-log — AdminAccessLog viewer (F5).
 *
 * Exempt from logAdminAccess by convention — the page reads the log, and
 * logging its own reads would grow the log without bound. The exemption
 * is enforced inside logAdminAccess itself (EXEMPT_PATHS set), so admin
 * callsites on this page can call it freely and get a no-op.
 */
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SearchParams {
  range?: string; // "24h" | "7d" | "30d" — default 7d
  action?: string; // "view" | "list" | "export"
}

function parseRange(range: string | undefined): { since: Date; label: string } {
  const now = Date.now();
  switch (range) {
    case "24h":
      return { since: new Date(now - 24 * 3600 * 1000), label: "24h" };
    case "30d":
      return { since: new Date(now - 30 * 24 * 3600 * 1000), label: "30d" };
    case "7d":
    default:
      return { since: new Date(now - 7 * 24 * 3600 * 1000), label: "7d" };
  }
}

export default async function AdminAccessLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const admin = await requireAdminContext("/admin/access-log");

  const params = await searchParams;
  const { since, label } = parseRange(params.range);
  const actionFilter = params.action;

  const rows = await prisma.adminAccessLog.findMany({
    where: {
      createdAt: { gte: since },
      ...(actionFilter ? { action: actionFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      admin: { select: { email: true } },
    },
  });

  const targetIds = Array.from(
    new Set(rows.map((r) => r.targetUserId).filter((v): v is string => Boolean(v))),
  );
  const targets =
    targetIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, email: true },
        });
  const targetEmailById = new Map(targets.map((t) => [t.id, t.email ?? t.id]));

  return (
    <main className="mx-auto max-w-6xl p-6 font-mono text-sm">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Admin · Access log</h1>
        <p className="text-zinc-500">
          Signed in as <code>{admin.email}</code> · Range: <code>{label}</code>
        </p>
      </header>

      <section className="mb-4 flex flex-wrap gap-2 text-xs">
        <RangeLink label="24h" current={label} target="24h" action={actionFilter} />
        <RangeLink label="7d" current={label} target="7d" action={actionFilter} />
        <RangeLink label="30d" current={label} target="30d" action={actionFilter} />
        <span className="mx-2 text-zinc-600">·</span>
        <ActionLink label="all" current={actionFilter} target={undefined} range={label} />
        <ActionLink label="view" current={actionFilter} target="view" range={label} />
        <ActionLink label="list" current={actionFilter} target="list" range={label} />
        <ActionLink label="export" current={actionFilter} target="export" range={label} />
      </section>

      {rows.length === 0 ? (
        <p className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-zinc-400">
          No admin reads recorded in the last {label}.
        </p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-zinc-700 text-left">
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Admin</th>
              <th className="py-2 pr-4">Action</th>
              <th className="py-2 pr-4">Path</th>
              <th className="py-2 pr-4">Target user</th>
              <th className="py-2 pr-4">Context</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const targetEmail = r.targetUserId
                ? targetEmailById.get(r.targetUserId) ?? r.targetUserId
                : null;
              return (
                <tr key={r.id} className="border-b border-zinc-800 align-top">
                  <td className="py-2 pr-4 whitespace-nowrap text-zinc-500">
                    {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="py-2 pr-4 text-zinc-300">{r.admin?.email ?? r.adminId}</td>
                  <td className={`py-2 pr-4 ${actionClass(r.action)}`}>{r.action}</td>
                  <td className="py-2 pr-4 text-zinc-200">{r.path}</td>
                  <td className="py-2 pr-4 text-zinc-400">{targetEmail ?? "—"}</td>
                  <td className="py-2 pr-4">
                    {r.contextJson ? (
                      <details>
                        <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
                          view
                        </summary>
                        <pre className="mt-2 max-w-[48ch] whitespace-pre-wrap break-all rounded bg-zinc-900 p-2 text-[11px] leading-4">
                          {JSON.stringify(r.contextJson, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <footer className="mt-8 text-xs text-zinc-500">
        <p>
          Showing up to 200 most recent rows · Return to{" "}
          <Link href="/admin" className="text-sky-400 hover:underline">
            /admin
          </Link>
          .
        </p>
      </footer>
    </main>
  );
}

function RangeLink({
  label,
  current,
  target,
  action,
}: {
  label: string;
  current: string;
  target: string;
  action?: string;
}) {
  const qs = new URLSearchParams();
  qs.set("range", target);
  if (action) qs.set("action", action);
  const active = current === target;
  return (
    <Link
      href={`/admin/access-log?${qs.toString()}`}
      className={`rounded border px-2 py-0.5 ${
        active
          ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
          : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {label}
    </Link>
  );
}

function ActionLink({
  label,
  current,
  target,
  range,
}: {
  label: string;
  current: string | undefined;
  target: string | undefined;
  range: string;
}) {
  const qs = new URLSearchParams();
  qs.set("range", range);
  if (target) qs.set("action", target);
  const active = (current ?? "") === (target ?? "");
  return (
    <Link
      href={`/admin/access-log?${qs.toString()}`}
      className={`rounded border px-2 py-0.5 ${
        active
          ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
          : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {label}
    </Link>
  );
}

function actionClass(action: string): string {
  return (
    {
      view: "text-sky-400",
      list: "text-zinc-300",
      export: "text-amber-400",
    }[action] ?? "text-zinc-300"
  );
}
