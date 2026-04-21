/**
 * /admin/events — ProductEvent stream viewer (F2 revised).
 *
 * Free-text-free by construction: the tracker's allowlist + scalar-only
 * prop guardrail means every row here is safe to render verbatim. Reads
 * are audited via F5 (action: "list"); we pass through aggregate props
 * in the context so "who looked at events, filtered to what" is visible
 * in /admin/access-log.
 */
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";
import { PRODUCT_EVENTS } from "@/lib/analytics/events";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SearchParams {
  range?: string; // "24h" | "7d" | "30d"
  name?: string;
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

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const admin = await requireAdminContext("/admin/events");
  const params = await searchParams;
  const { since, label } = parseRange(params.range);
  const nameFilter = params.name;

  await logAdminAccess({
    adminId: admin.id,
    path: "/admin/events",
    action: "list",
    targetUserId: null,
    context: { range: label, name: nameFilter ?? null },
  });

  const [rows, counts] = await Promise.all([
    prisma.productEvent.findMany({
      where: {
        createdAt: { gte: since },
        ...(nameFilter ? { name: nameFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        name: true,
        userId: true,
        sessionId: true,
        props: true,
        createdAt: true,
      },
    }),
    prisma.productEvent.groupBy({
      by: ["name"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { name: "desc" } },
    }),
  ]);

  const userIds = Array.from(
    new Set(rows.map((r) => r.userId).filter((v): v is string => Boolean(v))),
  );
  const users =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true },
        });
  const emailById = new Map(users.map((u) => [u.id, u.email ?? u.id]));

  const countsByName = new Map(counts.map((c) => [c.name, c._count._all]));

  return (
    <main className="mx-auto max-w-6xl p-6 font-mono text-sm">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Admin · Events</h1>
        <p className="text-zinc-500">
          Signed in as <code>{admin.email}</code> · Range: <code>{label}</code>
          {nameFilter ? (
            <>
              {" · Name: "}
              <code>{nameFilter}</code>
            </>
          ) : null}
        </p>
      </header>

      <section className="mb-4 flex flex-wrap gap-2 text-xs">
        <RangeLink label="24h" current={label} target="24h" name={nameFilter} />
        <RangeLink label="7d" current={label} target="7d" name={nameFilter} />
        <RangeLink label="30d" current={label} target="30d" name={nameFilter} />
        <span className="mx-2 text-zinc-600">·</span>
        <NameLink label="all" current={nameFilter} target={undefined} range={label} />
        {PRODUCT_EVENTS.map((n) => (
          <NameLink key={n} label={n} current={nameFilter} target={n} range={label} />
        ))}
      </section>

      <section className="mb-6 rounded border border-zinc-800 bg-zinc-900/40 p-3">
        <h2 className="mb-2 text-xs uppercase tracking-wide text-zinc-400">
          Counts in range ({label})
        </h2>
        {countsByName.size === 0 ? (
          <p className="text-xs text-zinc-500">No events.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            {PRODUCT_EVENTS.map((n) => {
              const c = countsByName.get(n) ?? 0;
              return (
                <li key={n} className="flex items-baseline justify-between">
                  <span className="text-zinc-300">{n}</span>
                  <span className={c === 0 ? "text-zinc-600" : "text-emerald-400"}>{c}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {rows.length === 0 ? (
        <p className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-zinc-400">
          No events in the last {label}
          {nameFilter ? ` for ${nameFilter}` : ""}.
        </p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-zinc-700 text-left">
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">User</th>
              <th className="py-2 pr-4">Session</th>
              <th className="py-2 pr-4">Props</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const email = r.userId ? emailById.get(r.userId) ?? r.userId : null;
              return (
                <tr key={r.id} className="border-b border-zinc-800 align-top">
                  <td className="py-2 pr-4 whitespace-nowrap text-zinc-500">
                    {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="py-2 pr-4 text-zinc-200">{r.name}</td>
                  <td className="py-2 pr-4 text-zinc-400">{email ?? <span className="text-zinc-600">—</span>}</td>
                  <td className="py-2 pr-4 text-zinc-500">
                    {r.sessionId ? <code>{r.sessionId.slice(0, 8)}…</code> : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="py-2 pr-4">
                    {r.props ? (
                      <code className="text-[11px] text-zinc-400">{JSON.stringify(r.props)}</code>
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
  name,
}: {
  label: string;
  current: string;
  target: string;
  name?: string;
}) {
  const qs = new URLSearchParams();
  qs.set("range", target);
  if (name) qs.set("name", name);
  const active = current === target;
  return (
    <Link
      href={`/admin/events?${qs.toString()}`}
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

function NameLink({
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
  if (target) qs.set("name", target);
  const active = (current ?? "") === (target ?? "");
  return (
    <Link
      href={`/admin/events?${qs.toString()}`}
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
