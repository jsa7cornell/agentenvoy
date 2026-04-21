/**
 * /admin/feedback/[id] — detail view of a FeedbackReport (F3).
 *
 * Renders the free-text inputs + the server-built bundle. Opening this
 * page writes an AdminAccessLog row with targetUserId set to the report
 * author and context carrying the reportId.
 *
 * Bundle renderer branches on `version`. v1 and v2 both supported
 * indefinitely; no backfill (N6 fold from 2026-04-21 proposal).
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";
import { AdminActionsPanel, type ActiveToken } from "./admin-actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface FilingContextShape {
  filedAt: string;
  timeSinceLastUserMsg: string | null;
  lastAgentOutcome: string;
  suspectedIncidentTurn?: {
    messageId: string;
    outcome: string;
    userMsg?: { id: string; content: string; createdAt: string } | null;
    agentMsg?: {
      id: string;
      content: string;
      createdAt: string;
      actions?: Array<{ action: string; params: Record<string, unknown> }>;
      actionResults?: Array<{
        action: string;
        success: boolean;
        message: string;
      }>;
    } | null;
  } | null;
  recentFailures?: Array<{
    messageId: string;
    action: string;
    failureReason: string;
    at: string;
  }>;
}

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
      agentTokens: {
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        include: { mintedBy: { select: { email: true } } },
      },
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
  const bundleVersion =
    typeof bundle?.version === "number" ? (bundle.version as number) : 1;
  const filingContext =
    bundleVersion === 2 && bundle && "filingContext" in bundle
      ? (bundle.filingContext as FilingContextShape | undefined)
      : undefined;
  const filedWhen = report.createdAt.toISOString().replace("T", " ").slice(0, 19);
  const hostEmail = report.user?.email ?? report.userId;

  const activeTokens: ActiveToken[] = report.agentTokens.map((t) => ({
    id: t.id,
    jti: t.jti,
    mintedByEmail: t.mintedBy?.email ?? null,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt.toISOString(),
    fetchCount: t.fetchCount,
  }));

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-4xl p-6">
        <header className="mb-6">
          <Link href="/admin/feedback" className="text-xs text-sky-400 hover:underline">
            &larr; /admin/feedback
          </Link>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Feedback report</h1>
              <p className="mt-1 text-xs text-zinc-400">
                <span className="font-mono">{filedWhen}</span>
                <span className="mx-2 text-zinc-700">·</span>
                {report.filedByGuest ? (
                  <>
                    by guest{" "}
                    <span className="text-zinc-200">
                      {report.guestName || report.guestEmail || "(unknown)"}
                    </span>{" "}
                    in <span className="text-zinc-200">{hostEmail}</span>&rsquo;s deal room
                  </>
                ) : (
                  <>
                    by <span className="text-zinc-200">{hostEmail}</span>
                  </>
                )}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {report.filedByGuest && (
                  <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                    guest-filed
                  </span>
                )}
                {report.area && (
                  <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
                    {report.area}
                  </span>
                )}
                {report.filedByGuest && report.guestEmail && (
                  <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {report.guestEmail}
                  </span>
                )}
                <span
                  className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 select-all"
                  title={report.id}
                >
                  {report.id}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                {report.status}
              </span>
              {report.resolved ? (
                <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-emerald-300">
                  resolved
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <AdminActionsPanel
          reportId={report.id}
          currentStatus={report.status}
          activeTokens={activeTokens}
        />

        <section className="mb-5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 className="mb-3 text-xs uppercase tracking-wider text-zinc-500">What happened?</h2>
          {report.userText ? (
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-100">
              {report.userText}
            </p>
          ) : (
            <p className="italic text-zinc-500">
              (No text — user submitted with empty field or prefill-only.)
            </p>
          )}
          {report.triedToDoText ? (
            <>
              <h2 className="mt-5 mb-3 text-xs uppercase tracking-wider text-zinc-500">
                What they were trying to do
              </h2>
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-100">
                {report.triedToDoText}
              </p>
            </>
          ) : null}
        </section>

        {filingContext ? (
          <section className="mb-5 rounded-lg border border-purple-500/30 bg-purple-500/5 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs uppercase tracking-wider text-purple-300">
                Filing context (v2 digest)
              </h2>
              <span className="text-[10px] text-zinc-500">
                filed {filingContext.timeSinceLastUserMsg ?? "?"} after last user msg · last turn: {filingContext.lastAgentOutcome}
              </span>
            </div>
            {filingContext.suspectedIncidentTurn ? (
              <div className="space-y-2 text-xs text-zinc-300">
                <p>
                  <span className="text-zinc-500">Suspected incident turn: </span>
                  <span className="font-mono text-purple-200">
                    {filingContext.suspectedIncidentTurn.messageId}
                  </span>
                  <span className="ml-2 text-zinc-500">({filingContext.suspectedIncidentTurn.outcome})</span>
                </p>
                {filingContext.suspectedIncidentTurn.userMsg ? (
                  <div className="rounded border border-zinc-800 bg-black/40 p-2">
                    <span className="text-[10px] uppercase text-zinc-500">User</span>
                    <p className="whitespace-pre-wrap text-zinc-200">
                      {filingContext.suspectedIncidentTurn.userMsg.content}
                    </p>
                  </div>
                ) : null}
                {filingContext.suspectedIncidentTurn.agentMsg ? (
                  <div className="rounded border border-zinc-800 bg-black/40 p-2">
                    <span className="text-[10px] uppercase text-zinc-500">Agent</span>
                    <p className="whitespace-pre-wrap text-zinc-200">
                      {filingContext.suspectedIncidentTurn.agentMsg.content}
                    </p>
                    {filingContext.suspectedIncidentTurn.agentMsg.actionResults?.length ? (
                      <ul className="mt-2 space-y-0.5 text-[11px]">
                        {filingContext.suspectedIncidentTurn.agentMsg.actionResults.map((r, i) => (
                          <li key={i} className={r.success ? "text-emerald-300" : "text-red-300"}>
                            {r.success ? "✓" : "✗"} {r.action} — {r.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs italic text-zinc-500">No recent turns to correlate.</p>
            )}
            {filingContext.recentFailures && filingContext.recentFailures.length > 0 ? (
              <div className="mt-3">
                <h3 className="text-[10px] uppercase tracking-wider text-zinc-500">
                  Recent failures
                </h3>
                <ul className="mt-1 space-y-0.5 text-[11px] text-red-300">
                  {filingContext.recentFailures.map((f, i) => (
                    <li key={i}>
                      ✗ {f.action} — {f.failureReason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="mb-5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 className="mb-3 text-xs uppercase tracking-wider text-zinc-500">Client</h2>
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-zinc-500">URL</dt>
            <dd className="break-all text-zinc-200">
              {report.url ?? <em className="text-zinc-600">—</em>}
            </dd>
            <dt className="text-zinc-500">User-Agent</dt>
            <dd className="break-all font-mono text-xs text-zinc-300">
              {report.userAgent ?? <em className="font-sans text-zinc-600">—</em>}
            </dd>
            <dt className="text-zinc-500">Session</dt>
            <dd className="text-zinc-200">
              {report.sessionId ? (
                <code className="font-mono text-xs">{report.sessionId}</code>
              ) : (
                <em className="text-zinc-600">—</em>
              )}
            </dd>
          </dl>
        </section>

        <section className="mb-5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 className="mb-3 text-xs uppercase tracking-wider text-zinc-500">Checklist (consent)</h2>
          {checklist ? (
            <ul className="space-y-1 text-sm">
              {Object.entries(checklist).map(([k, v]) => (
                <li key={k} className="flex items-center gap-2">
                  <span
                    className={`inline-block h-4 w-4 rounded border text-center text-[10px] leading-4 ${
                      v
                        ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                        : "border-zinc-700 bg-zinc-900 text-zinc-600"
                    }`}
                  >
                    {v ? "✓" : ""}
                  </span>
                  <span className={v ? "text-zinc-200" : "text-zinc-500"}>{k}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-zinc-500">—</p>
          )}
        </section>

        <section className="mb-5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wider text-zinc-500">Attached bundle</h2>
            <span className="text-[10px] text-zinc-600">JSONB · schema v{bundleVersion}</span>
          </div>
          <details>
            <summary className="cursor-pointer text-sm text-sky-400 hover:text-sky-300">
              Expand full JSON
            </summary>
            <pre className="mt-3 max-h-[600px] overflow-auto whitespace-pre-wrap break-all rounded border border-zinc-800 bg-black/60 p-3 text-[11px] leading-relaxed text-zinc-300">
              {JSON.stringify(bundle, null, 2)}
            </pre>
          </details>
        </section>

        <footer className="mt-10 text-xs text-zinc-500">
          View audited in{" "}
          <Link href="/admin/access-log" className="text-sky-400 hover:underline">
            /admin/access-log
          </Link>
          .
        </footer>
      </div>
    </main>
  );
}
