/**
 * /admin/side-effects — side-effect dispatcher audit log.
 * OAuth-gated to ADMIN_EMAIL; non-admins get 404.
 */

import { requireAdminPage } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SearchParams {
  kind?: string;
  status?: string;
}

export default async function AdminSideEffectsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdminPage();

  const params = await searchParams;
  const filters: Record<string, string> = {};
  if (params.kind) filters.kind = params.kind;
  if (params.status) filters.status = params.status;

  const rows = await prisma.sideEffectLog.findMany({
    where: filters,
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const counts = {
    total: rows.length,
    sent: rows.filter((r) => r.status === "sent").length,
    suppressed: rows.filter((r) => r.status === "suppressed").length,
    dryrun: rows.filter((r) => r.status === "dryrun").length,
    failed: rows.filter((r) => r.status === "failed").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
  };

  return (
    <main className="mx-auto max-w-6xl p-6 font-mono text-sm">
      <div className="mb-4">
        <Link href="/admin" className="text-xs text-violet-400 hover:text-violet-300">← Admin</Link>
      </div>

      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Side Effect Log</h1>
        <p className="text-zinc-500">
          Last 100 · Env: <code>{process.env.VERCEL_ENV ?? process.env.NODE_ENV}</code>
        </p>
      </header>

      <section className="mb-6 flex flex-wrap gap-4 text-xs">
        <Stat label="total" value={counts.total} />
        <Stat label="sent" value={counts.sent} tone="green" />
        <Stat label="suppressed" value={counts.suppressed} tone="amber" />
        <Stat label="dryrun" value={counts.dryrun} tone="blue" />
        <Stat label="failed" value={counts.failed} tone="red" />
        <Stat label="skipped" value={counts.skipped} tone="gray" />
      </section>

      <section className="mb-4 flex flex-wrap gap-2 text-xs">
        <FilterLink label="all" current={filters} />
        <FilterLink label="email.send" current={filters} param="kind" value="email.send" />
        <span className="mx-2 text-zinc-500">·</span>
        <FilterLink label="sent" current={filters} param="status" value="sent" />
        <FilterLink label="suppressed" current={filters} param="status" value="suppressed" />
        <FilterLink label="dryrun" current={filters} param="status" value="dryrun" />
        <FilterLink label="failed" current={filters} param="status" value="failed" />
      </section>

      {rows.length === 0 ? (
        <p className="text-zinc-500">No entries match these filters.</p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-zinc-700 text-left">
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Kind</th>
              <th className="py-2 pr-4">Mode</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Target</th>
              <th className="py-2 pr-4">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-zinc-800 align-top">
                <td className="py-2 pr-4 whitespace-nowrap text-zinc-500">
                  {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="py-2 pr-4">{r.kind}</td>
                <td className="py-2 pr-4">{r.mode}</td>
                <td className={`py-2 pr-4 ${statusClass(r.status)}`}>{r.status}</td>
                <td className="py-2 pr-4 max-w-[28ch] truncate" title={r.targetSummary ?? ""}>
                  {r.targetSummary}
                </td>
                <td className="py-2 pr-4">
                  <details>
                    <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
                      {r.error ? "error" : "payload"}
                    </summary>
                    <pre className="mt-2 max-w-[48ch] whitespace-pre-wrap break-all rounded bg-zinc-900 p-2 text-[11px] leading-4">
                      {r.error ??
                        JSON.stringify(
                          { payload: r.payload, context: r.contextJson, providerRef: r.providerRef },
                          null,
                          2,
                        )}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "green" | "amber" | "blue" | "red" | "gray" }) {
  const toneClass = { default: "text-zinc-300", green: "text-emerald-400", amber: "text-amber-400", blue: "text-sky-400", red: "text-red-400", gray: "text-zinc-500" }[tone];
  return <span className={toneClass}>{label}: <strong>{value}</strong></span>;
}

function FilterLink({ label, current, param, value }: { label: string; current: Record<string, string>; param?: keyof SearchParams; value?: string }) {
  const next = { ...current };
  if (!param) {
    Object.keys(next).forEach((k) => delete next[k]);
  } else if (value) {
    next[param] = value;
  }
  const qs = new URLSearchParams(next).toString();
  const active = (!param && Object.keys(current).length === 0) || (param && value && current[param] === value);
  return (
    <Link
      href={`/admin/side-effects${qs ? `?${qs}` : ""}`}
      className={`rounded border px-2 py-0.5 ${active ? "border-emerald-500 bg-emerald-500/20 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
    >
      {label}
    </Link>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case "sent": return "text-emerald-400";
    case "suppressed": return "text-amber-400";
    case "dryrun": return "text-sky-400";
    case "failed": return "text-red-400";
    case "skipped": return "text-zinc-500";
    default: return "text-zinc-300";
  }
}
