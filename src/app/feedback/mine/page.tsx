/**
 * /feedback/mine — host-visible list of their own submitted feedback reports.
 *
 * Scope (decided 2026-04-21, proposal §Q6): NextAuth-authenticated ONLY.
 * Filters to `filedByGuest: false` + session.user.id. Guests who file via
 * linkCode cannot see this list (no account to sign into) — by design;
 * email support@agentenvoy.com is the documented fallback.
 *
 * Read-only. No mint/share/revoke. Status is displayed (new/acked/etc.) so
 * the filer can see if we've triaged their report.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function statusClass(status: string): string {
  switch (status) {
    case "resolved":
      return "text-emerald-400";
    case "wontfix":
      return "text-zinc-400";
    case "in_progress":
      return "text-sky-400";
    case "acknowledged":
      return "text-indigo-300";
    case "new":
    default:
      return "text-amber-400";
  }
}

export default async function MyFeedbackPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/feedback/mine");
  }

  const rows = await prisma.feedbackReport.findMany({
    where: { userId: session.user.id, filedByGuest: false },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      createdAt: true,
      status: true,
      resolved: true,
      area: true,
      userText: true,
      url: true,
    },
  });

  return (
    <main className="mx-auto max-w-3xl p-6 font-mono text-sm">
      <header className="mb-6">
        <h1 className="text-xl font-bold">My feedback</h1>
        <p className="mt-1 text-xs text-zinc-500">
          Reports you&apos;ve submitted from the dashboard or deal-room. Guests&apos;
          reports aren&apos;t shown here.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-zinc-400">
          No feedback submitted yet. Click &quot;Report a problem&quot; in the app to
          file one.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const text = r.userText ?? "(no text)";
            const preview = text.length > 140 ? `${text.slice(0, 140)}…` : text;
            return (
              <li
                key={r.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
              >
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-zinc-500">
                    {r.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                  </span>
                  <span className={statusClass(r.status)}>{r.status}</span>
                </div>
                <p className="mt-1 text-sm text-zinc-200">{preview}</p>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                  {r.area && <span>area: {r.area}</span>}
                  {r.url && (
                    <span className="truncate">
                      on: <code>{r.url}</code>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="mt-8 text-xs text-zinc-500">
        <p>
          Return to{" "}
          <Link href="/dashboard" className="text-sky-400 hover:underline">
            dashboard
          </Link>
          . Questions? Email{" "}
          <a
            className="text-sky-400 hover:underline"
            href="mailto:support@agentenvoy.com"
          >
            support@agentenvoy.com
          </a>
          .
        </p>
      </footer>
    </main>
  );
}
