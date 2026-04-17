/**
 * Admin failure log — OAuth-gated to ADMIN_EMAIL.
 *
 * Shows three feeds interleaved by time:
 *   1. ConfirmAttempt rows where outcome !== 'success' | 'already_agreed'
 *   2. RouteError rows (all)
 *   3. SideEffectLog rows where status === 'failed'
 *
 * If the visitor is not signed in as the admin email, the page 404s
 * (deliberate — we don't want to leak existence of /admin/* to anyone).
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SearchParams {
  range?: string; // "24h" | "7d" | "30d" — default 7d
  source?: string; // "confirm" | "route" | "sideeffect" | undefined (all)
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";

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

type FeedRow =
  | {
      source: "confirm";
      id: string;
      createdAt: Date;
      primary: string;
      secondary: string;
      detail: string;
      tone: "red" | "amber";
    }
  | {
      source: "route";
      id: string;
      createdAt: Date;
      primary: string;
      secondary: string;
      detail: string;
      tone: "red";
    }
  | {
      source: "sideeffect";
      id: string;
      createdAt: Date;
      primary: string;
      secondary: string;
      detail: string;
      tone: "red";
    };

export default async function AdminFailuresPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email || session.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    notFound();
  }

  const params = await searchParams;
  const { since, label } = parseRange(params.range);
  const source = params.source;

  const [confirmRows, routeRows, sideEffectRows, confirmCounts] = await Promise.all([
    (!source || source === "confirm")
      ? prisma.confirmAttempt.findMany({
          where: {
            createdAt: { gte: since },
            outcome: { notIn: ["success", "already_agreed"] },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        })
      : Promise.resolve([]),
    (!source || source === "route")
      ? prisma.routeError.findMany({
          where: { createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
          take: 200,
        })
      : Promise.resolve([]),
    (!source || source === "sideeffect")
      ? prisma.sideEffectLog.findMany({
          where: { createdAt: { gte: since }, status: "failed" },
          orderBy: { createdAt: "desc" },
          take: 200,
        })
      : Promise.resolve([]),
    // Summary over the full range, unfiltered — so the header always
    // shows the rate regardless of current source filter.
    prisma.confirmAttempt.groupBy({
      by: ["outcome"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const rows: FeedRow[] = [
    ...confirmRows.map<FeedRow>((r) => ({
      source: "confirm",
      id: r.id,
      createdAt: r.createdAt,
      primary: `Confirm ${r.outcome}`,
      secondary: r.sessionId ? `session ${r.sessionId}` : "(no session)",
      detail: [
        r.errorMessage ?? "(no error message)",
        r.slotStart ? `slot: ${r.slotStart.toISOString()}` : "",
        r.userAgent ? `ua: ${r.userAgent}` : "",
        r.durationMs != null ? `${r.durationMs}ms` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      tone: r.outcome === "slot_mismatch" ? "amber" : "red",
    })),
    ...routeRows.map<FeedRow>((r) => ({
      source: "route",
      id: r.id,
      createdAt: r.createdAt,
      primary: `${r.method ?? ""} ${r.route}`.trim(),
      secondary: r.errorClass ?? "Error",
      detail: [
        r.message,
        r.contextJson ? `context: ${JSON.stringify(r.contextJson)}` : "",
        r.userAgent ? `ua: ${r.userAgent}` : "",
        r.stack ? `\n${r.stack}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      tone: "red",
    })),
    ...sideEffectRows.map<FeedRow>((r) => ({
      source: "sideeffect",
      id: r.id,
      createdAt: r.createdAt,
      primary: `Dispatch failed: ${r.kind}`,
      secondary: r.targetSummary,
      detail: [
        r.error ?? "(no error)",
        `mode: ${r.mode}`,
        r.providerRef ? `ref: ${r.providerRef}` : "",
        r.contextJson ? `context: ${JSON.stringify(r.contextJson)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      tone: "red",
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const totals = {
    confirm: confirmRows.length,
    route: routeRows.length,
    sideeffect: sideEffectRows.length,
    all: rows.length,
  };

  const confirmByOutcome = Object.fromEntries(
    confirmCounts.map((c) => [c.outcome, c._count._all])
  ) as Record<string, number>;
  const confirmTotal = Object.values(confirmByOutcome).reduce((a, b) => a + b, 0);
  const confirmSuccess =
    (confirmByOutcome.success ?? 0) + (confirmByOutcome.already_agreed ?? 0);
  const confirmSuccessRate = confirmTotal === 0 ? 1 : confirmSuccess / confirmTotal;

  return (
    <main className="mx-auto max-w-6xl p-6 font-mono text-sm">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Admin · Failures</h1>
        <p className="text-zinc-500">
          Signed in as <code>{session.user.email}</code> · Range: <code>{label}</code>
        </p>
      </header>

      <section className="mb-6 grid grid-cols-2 gap-4 rounded border border-zinc-800 p-4 md:grid-cols-4">
        <Stat label="confirm attempts" value={confirmTotal} tone="default" />
        <Stat
          label="confirm success rate"
          value={`${(confirmSuccessRate * 100).toFixed(1)}%`}
          tone={confirmSuccessRate > 0.95 ? "green" : confirmSuccessRate > 0.8 ? "amber" : "red"}
        />
        <Stat label="failed confirms" value={confirmRows.length} tone="red" />
        <Stat label="route errors" value={routeRows.length} tone="red" />
      </section>

      <section className="mb-4 flex flex-wrap gap-2 text-xs">
        <RangeLink label="24h" current={label} target="24h" source={source} />
        <RangeLink label="7d" current={label} target="7d" source={source} />
        <RangeLink label="30d" current={label} target="30d" source={source} />
        <span className="mx-2 text-zinc-600">·</span>
        <SourceLink label="all" current={source} target={undefined} range={label} />
        <SourceLink label={`confirm (${totals.confirm})`} current={source} target="confirm" range={label} />
        <SourceLink label={`route (${totals.route})`} current={source} target="route" range={label} />
        <SourceLink label={`side effects (${totals.sideeffect})`} current={source} target="sideeffect" range={label} />
      </section>

      {rows.length === 0 ? (
        <p className="rounded border border-emerald-900 bg-emerald-950/30 p-4 text-emerald-300">
          No failures in the last {label}. 🎉
        </p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-zinc-700 text-left">
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">What</th>
              <th className="py-2 pr-4">Where</th>
              <th className="py-2 pr-4">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.source}-${r.id}`} className="border-b border-zinc-800 align-top">
                <td className="py-2 pr-4 whitespace-nowrap text-zinc-500">
                  {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className={`py-2 pr-4 ${sourceClass(r.source)}`}>{r.source}</td>
                <td className={`py-2 pr-4 ${toneClass(r.tone)}`}>{r.primary}</td>
                <td className="py-2 pr-4 max-w-[32ch] truncate" title={r.secondary}>
                  {r.secondary}
                </td>
                <td className="py-2 pr-4">
                  <details>
                    <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
                      view
                    </summary>
                    <pre className="mt-2 max-w-[64ch] whitespace-pre-wrap break-all rounded bg-zinc-900 p-2 text-[11px] leading-4">
                      {r.detail}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer className="mt-8 text-xs text-zinc-500">
        <p>
          Pair this with <Link href="/dev/side-effects" className="text-sky-400 hover:underline">/dev/side-effects</Link>{" "}
          for the full dispatch audit trail (sent + dryrun + suppressed).
        </p>
      </footer>
    </main>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "default" | "green" | "amber" | "red";
}) {
  const toneClassMap = {
    default: "text-zinc-300",
    green: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-red-400",
  } as const;
  return (
    <div>
      <div className="text-zinc-500 text-[11px] uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-bold ${toneClassMap[tone]}`}>{value}</div>
    </div>
  );
}

function RangeLink({
  label,
  current,
  target,
  source,
}: {
  label: string;
  current: string;
  target: string;
  source?: string;
}) {
  const qs = new URLSearchParams();
  qs.set("range", target);
  if (source) qs.set("source", source);
  const active = current === target;
  return (
    <Link
      href={`/admin/failures?${qs.toString()}`}
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

function SourceLink({
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
  if (target) qs.set("source", target);
  const active = (current ?? "") === (target ?? "");
  return (
    <Link
      href={`/admin/failures?${qs.toString()}`}
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

function toneClass(tone: "red" | "amber"): string {
  return tone === "red" ? "text-red-400" : "text-amber-400";
}

function sourceClass(source: "confirm" | "route" | "sideeffect"): string {
  return {
    confirm: "text-purple-400",
    route: "text-sky-400",
    sideeffect: "text-amber-400",
  }[source];
}
