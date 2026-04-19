/**
 * /admin — central admin portal.
 * OAuth-gated to ADMIN_EMAIL; non-admins get 404.
 */

import { requireAdminPage, ADMIN_EMAIL } from "@/lib/admin-auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface Tool {
  href: string;
  label: string;
  description: string;
  tag?: string;
}

const TOOLS: Tool[] = [
  {
    href: "/admin/failures",
    label: "Failure Log",
    description: "ConfirmAttempt failures, RouteErrors, and failed side effects. Filterable by time range.",
    tag: "monitoring",
  },
  {
    href: "/admin/side-effects",
    label: "Side Effect Log",
    description: "Last 100 dispatcher events — emails, calendar ops. Filter by kind and status.",
    tag: "monitoring",
  },
  {
    href: "/admin/emails",
    label: "Email Templates",
    description: "Live previews of all email templates with sample data. Send a real test email to your inbox.",
    tag: "email",
  },
  {
    href: "/api/admin/smoke",
    label: "Smoke Test",
    description: "Post-deploy health probe: DB roundtrip, migration parity, SES credentials, calendar cache, critical env vars. Returns JSON — open in browser after a deploy.",
    tag: "monitoring",
  },
  {
    href: "/api/admin/schema-health",
    label: "Schema Health",
    description: "On-demand schema drift check. Returns JSON — open in browser to see if Prisma and Supabase are in sync.",
    tag: "database",
  },
  {
    href: "/api/admin/env-health",
    label: "Env Health",
    description: "On-demand production env-var sanity check. Returns JSON listing any critical/warn findings. Cron runs this daily.",
    tag: "database",
  },
  {
    href: "/admin/repair",
    label: "Data Repair",
    description: "One-off data-repair surfaces. Today: re-dispatch confirmed meetings that landed with dryrun-* eventIds from the EFFECT_MODE_CALENDAR config miss.",
    tag: "database",
  },
];

const TAG_COLORS: Record<string, string> = {
  monitoring: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  email: "bg-violet-500/10 text-violet-400 border-violet-500/30",
  database: "bg-amber-500/10 text-amber-400 border-amber-500/30",
};

export default async function AdminPage() {
  await requireAdminPage();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="max-w-2xl mx-auto">
        <header className="mb-10">
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-2">AgentEnvoy</p>
          <h1 className="text-2xl font-bold mb-1">Admin</h1>
          <p className="text-sm text-zinc-500">Signed in as {ADMIN_EMAIL}</p>
        </header>

        <div className="grid gap-3">
          {TOOLS.map((tool) => (
            <Link
              key={tool.href}
              href={tool.href}
              className="group flex items-start justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-5 py-4 hover:border-violet-700 hover:bg-zinc-800 transition-colors"
            >
              <div className="flex-1 min-w-0 mr-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-sm text-zinc-100 group-hover:text-white">{tool.label}</span>
                  {tool.tag && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${TAG_COLORS[tool.tag] ?? ""}`}>
                      {tool.tag}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 leading-relaxed">{tool.description}</p>
              </div>
              <span className="text-zinc-600 group-hover:text-violet-400 mt-0.5 transition-colors text-sm">→</span>
            </Link>
          ))}
        </div>

        <footer className="mt-12 text-xs text-zinc-700 text-center">
          agentenvoy.ai/admin · {ADMIN_EMAIL}
        </footer>
      </div>
    </main>
  );
}
