/**
 * /admin/repair — one-off data-repair surface.
 *
 * Today: repair sessions with `calendarEventId LIKE 'dryrun-%'` — the
 * 2026-04-17 Phase 2 calendar-dispatcher config miss. Future repair jobs
 * will accrete here; keep each one self-contained.
 *
 * OAuth-gated to ADMIN_EMAIL via requireAdminPage(); 404s otherwise.
 */

import Link from "next/link";
import { requireAdminPage } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { DryrunRepairClient } from "./dryrun-repair-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminRepairPage() {
  await requireAdminPage("/admin/repair");

  // Server-fetch the list so the initial render doesn't flash empty.
  const broken = await prisma.negotiationSession.findMany({
    where: {
      status: "agreed",
      archived: false,
      calendarEventId: { startsWith: "dryrun-" },
    },
    select: {
      id: true,
      title: true,
      guestName: true,
      guestEmail: true,
      agreedTime: true,
      agreedFormat: true,
      duration: true,
      calendarEventId: true,
      meetLink: true,
      host: { select: { id: true, name: true, email: true } },
      link: {
        select: { slug: true, code: true, topic: true },
      },
    },
    orderBy: { agreedTime: "desc" },
  });

  return (
    <div className="min-h-screen bg-surface text-primary p-6">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link
              href="/admin"
              className="text-xs text-muted hover:text-secondary transition"
            >
              ← Admin
            </Link>
            <h1 className="text-2xl font-bold mt-2">Data Repair</h1>
          </div>
        </div>

        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-2">Dryrun calendar-event repair</h2>
          <p className="text-sm text-secondary mb-4 leading-relaxed">
            Sessions below were confirmed while <code className="text-xs bg-surface-secondary px-1 py-0.5 rounded">EFFECT_MODE_CALENDAR</code> was
            defaulting to <code className="text-xs bg-surface-secondary px-1 py-0.5 rounded">dryrun</code> in
            production (2026-04-17 Phase 2 deploy). They are marked agreed in
            the DB but have a synthetic <code className="text-xs bg-surface-secondary px-1 py-0.5 rounded">dryrun-*</code> eventId
            — no real Google Calendar event exists. Click &ldquo;Repair&rdquo; to
            re-dispatch <code className="text-xs bg-surface-secondary px-1 py-0.5 rounded">calendar.create_event</code> and
            patch the session with the real eventId + meet link.
          </p>
          <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 p-3 mb-4 text-xs text-amber-100/80 leading-relaxed">
            <div className="font-semibold text-amber-200 mb-1">Before you click Repair</div>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>The guest already got a confirmation email with a fake meet link. Decide whether to notify them again.</li>
              <li><strong>Quiet</strong> (default): no GCal invite email — you handle follow-up manually.</li>
              <li><strong>Notify</strong>: Google sends a fresh invite to attendees. Cleaner but may confuse (second invite for a meeting they think is confirmed).</li>
              <li>Safe to retry if a repair fails — the session keeps its dryrun-* ID until a repair succeeds.</li>
            </ul>
          </div>

          <DryrunRepairClient initial={broken} />
        </section>
      </div>
    </div>
  );
}
