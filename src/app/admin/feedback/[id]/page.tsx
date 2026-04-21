/**
 * /admin/feedback/[id] — detail view of a FeedbackReport (F3).
 *
 * Renders the free-text inputs + the server-built bundle. Opening this
 * page writes an AdminAccessLog row with targetUserId set to the report
 * author and context carrying the reportId.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminFeedbackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = await requireAdminContext(`/admin/feedback/${id}`);

  const report = await prisma.feedbackReport.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, email: true } },
    },
  });
  if (!report) notFound();

  await logAdminAccess({
    adminId: admin.id,
    path: "/admin/feedback/:id",
    action: "view",
    targetUserId: report.userId,
    context: { feedbackReportId: report.id },
  });

  const checklist = report.checklistState as Record<string, boolean> | null;
  const bundle = report.bundle as Record<string, unknown> | null;

  return (
    <main className="mx-auto max-w-4xl p-6 font-mono text-sm">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold">Feedback · {report.id.slice(0, 10)}…</h1>
          <p className="mt-1 text-zinc-500">
            Filed{" "}
            <code>{report.createdAt.toISOString().replace("T", " ").slice(0, 19)}</code> by{" "}
            <code>{report.user?.email ?? report.userId}</code>
          </p>
        </div>
        <div>
          {report.resolved ? (
            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
              resolved
            </span>
          ) : (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
              open
            </span>
          )}
        </div>
      </header>

      <section className="mb-6 rounded border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-2 text-xs uppercase tracking-wide text-zinc-400">What happened?</h2>
        <pre className="whitespace-pre-wrap text-sm text-zinc-100">{report.userText}</pre>
        {report.triedToDoText ? (
          <>
            <h2 className="mt-4 mb-2 text-xs uppercase tracking-wide text-zinc-400">
              What they were trying to do
            </h2>
            <pre className="whitespace-pre-wrap text-sm text-zinc-100">{report.triedToDoText}</pre>
          </>
        ) : null}
      </section>

      <section className="mb-6 rounded border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-2 text-xs uppercase tracking-wide text-zinc-400">Request headers</h2>
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-xs">
          <dt className="text-zinc-500">URL</dt>
          <dd className="text-zinc-200 break-all">{report.url ?? <em className="text-zinc-600">—</em>}</dd>
          <dt className="text-zinc-500">User-Agent</dt>
          <dd className="text-zinc-200 break-all">
            {report.userAgent ?? <em className="text-zinc-600">—</em>}
          </dd>
          <dt className="text-zinc-500">Session</dt>
          <dd className="text-zinc-200">
            {report.sessionId ? (
              <code>{report.sessionId}</code>
            ) : (
              <em className="text-zinc-600">—</em>
            )}
          </dd>
        </dl>
      </section>

      <section className="mb-6 rounded border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-2 text-xs uppercase tracking-wide text-zinc-400">Checklist (consent)</h2>
        {checklist ? (
          <ul className="space-y-0.5 text-xs">
            {Object.entries(checklist).map(([k, v]) => (
              <li key={k}>
                <code className={v ? "text-emerald-400" : "text-zinc-600"}>
                  {v ? "[x]" : "[ ]"} {k}
                </code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-zinc-600">—</p>
        )}
      </section>

      <section className="mb-6 rounded border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-400">
          <span>Attached bundle</span>
          <span className="text-[10px] text-zinc-600">JSONB · schema v1</span>
        </h2>
        <details>
          <summary className="cursor-pointer text-sky-400 hover:text-sky-300">
            Expand full JSON
          </summary>
          <pre className="mt-3 max-h-[600px] overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-3 text-[11px] leading-relaxed text-zinc-300">
            {JSON.stringify(bundle, null, 2)}
          </pre>
        </details>
      </section>

      <footer className="mt-8 text-xs text-zinc-500">
        <p>
          Viewing this page is logged in{" "}
          <Link href="/admin/access-log" className="text-sky-400 hover:underline">
            /admin/access-log
          </Link>
          . Back to{" "}
          <Link href="/admin/feedback" className="text-sky-400 hover:underline">
            /admin/feedback
          </Link>
          .
        </p>
      </footer>
    </main>
  );
}
