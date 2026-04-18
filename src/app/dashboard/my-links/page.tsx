/**
 * /dashboard/my-links — host's library of scheduling links + last-7-days stats.
 *
 * Three sections:
 *   - Primary link (agentenvoy.ai/meet/{slug}) with copy + share affordances
 *   - Office hours links (from preferences.explicit.structuredRules)
 *   - Contextual links (NegotiationLink rows, type=contextual, not expired)
 *
 * Stats are computed inline against NegotiationSession — no new tables, and
 * the queries are cheap because hostId is indexed. "Stalled" is approximated
 * as active + no activity in the last 48h.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { compileOfficeHoursLinks, type AvailabilityRule } from "@/lib/availability-rules";
import { CopyLinkButton } from "./copy-link-button";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STALL_THRESHOLD_MS = 48 * 60 * 60 * 1000;

export default async function MyLinksPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/api/auth/signin?callbackUrl=/dashboard/my-links");
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: {
      id: true,
      name: true,
      meetSlug: true,
      preferences: true,
    },
  });
  if (!user || !user.meetSlug) {
    redirect("/dashboard/account");
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://agentenvoy.ai";
  const meetUrl = `${baseUrl}/meet/${user.meetSlug}`;

  // ── Stats for primary link over last 7 days ─────────────────────────────
  const since = new Date(Date.now() - WINDOW_MS);
  const stallCutoff = new Date(Date.now() - STALL_THRESHOLD_MS);

  const [genericLink, created, confirmed, cancelled, stalled] = await Promise.all([
    prisma.negotiationLink.findFirst({
      where: { userId: user.id, type: "generic" },
      select: { id: true },
    }),
    prisma.negotiationSession.count({
      where: {
        hostId: user.id,
        createdAt: { gte: since },
        link: { type: "generic" },
      },
    }),
    prisma.negotiationSession.count({
      where: {
        hostId: user.id,
        status: "agreed",
        archived: false,
        updatedAt: { gte: since },
        link: { type: "generic" },
      },
    }),
    prisma.negotiationSession.count({
      where: {
        hostId: user.id,
        archived: true,
        updatedAt: { gte: since },
        link: { type: "generic" },
      },
    }),
    prisma.negotiationSession.count({
      where: {
        hostId: user.id,
        status: "active",
        archived: false,
        updatedAt: { lte: stallCutoff },
        createdAt: { gte: since },
        link: { type: "generic" },
      },
    }),
  ]);

  // ── Office hours links (from structured rules) ──────────────────────────
  const prefs = (user.preferences as Record<string, unknown> | null) || {};
  const explicit = (prefs.explicit as Record<string, unknown> | undefined) || {};
  const rules = (explicit.structuredRules as AvailabilityRule[] | undefined) || [];
  const officeHours = compileOfficeHoursLinks(rules);

  // ── Contextual links ────────────────────────────────────────────────────
  const now = new Date();
  const contextualLinks = await prisma.negotiationLink.findMany({
    where: {
      userId: user.id,
      type: "contextual",
      OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
    },
    select: {
      id: true,
      code: true,
      slug: true,
      inviteeName: true,
      inviteeEmail: true,
      topic: true,
      expiresAt: true,
      createdAt: true,
      sessions: {
        where: { archived: false },
        select: { status: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold">My Links</h1>
          <p className="text-sm text-muted mt-1">
            Every way someone can book time with you.
          </p>
        </div>

        {/* ── Primary link ─────────────────────────────────────────── */}
        <section>
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted mb-2">
            Your primary link
          </h2>
          <div className="rounded-xl border border-purple-800/40 bg-gradient-to-br from-purple-900/20 to-surface-secondary p-5">
            <div className="flex items-center gap-2 text-sm font-mono text-purple-300 break-all">
              {meetUrl}
            </div>
            <p className="text-xs text-secondary mt-1.5 leading-snug">
              Share this with anyone. They can book time based on your default
              preferences.
            </p>
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              <CopyLinkButton url={meetUrl} />
              <a
                href={meetUrl}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-DEFAULT text-secondary hover:text-primary hover:border-zinc-500 transition"
              >
                Open as guest →
              </a>
            </div>
          </div>

          {/* 7-day stats */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Sessions created" value={created} since="7d" />
            <StatCard label="Confirmed" value={confirmed} since="7d" tone="emerald" />
            <StatCard label="Cancelled" value={cancelled} since="7d" tone="muted" />
            <StatCard label="Stalled >48h" value={stalled} since="7d" tone={stalled > 0 ? "amber" : "muted"} />
          </div>
          {!genericLink && (
            <p className="text-xs text-muted mt-3">
              Heads up — your generic link doesn&apos;t have a corresponding NegotiationLink
              row yet. First guest visit will create one.
            </p>
          )}
        </section>

        {/* ── Office hours ─────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted">
              Office hours
            </h2>
            <Link
              href="/dashboard/availability"
              className="text-[11px] text-indigo-400 hover:text-indigo-300 transition"
            >
              Manage rules →
            </Link>
          </div>
          {officeHours.length === 0 ? (
            <div className="rounded-lg border border-DEFAULT bg-surface-secondary/40 p-4 text-xs text-secondary">
              No office-hours links yet. You can declare one in{" "}
              <Link
                href="/dashboard/availability"
                className="text-indigo-400 hover:text-indigo-300 underline"
              >
                availability
              </Link>{" "}
              with something like &ldquo;office hours Tuesdays 2–4pm, 20-min video calls.&rdquo;
            </div>
          ) : (
            <div className="space-y-2">
              {officeHours.map((oh) => {
                const url = `${baseUrl}/meet/${oh.linkSlug}/${oh.linkCode}`;
                const window = `${oh.windowStart}–${oh.windowEnd}`;
                const days =
                  oh.daysOfWeek.length === 0
                    ? "every day"
                    : oh.daysOfWeek
                        .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d])
                        .join(" ");
                return (
                  <div
                    key={oh.ruleId}
                    className="rounded-lg border border-DEFAULT bg-surface-secondary p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold">{oh.title}</div>
                        <div className="text-xs text-muted">
                          {days} · {window} · {oh.durationMinutes}-min {oh.format}
                          {oh.expiryDate && ` · expires ${oh.expiryDate}`}
                        </div>
                        <div className="text-[11px] font-mono text-purple-300 mt-1 break-all">
                          {url}
                        </div>
                      </div>
                      <CopyLinkButton url={url} compact />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Contextual links ─────────────────────────────────────── */}
        <section>
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted mb-2">
            Per-invite links
          </h2>
          {contextualLinks.length === 0 ? (
            <div className="rounded-lg border border-DEFAULT bg-surface-secondary/40 p-4 text-xs text-secondary">
              Per-invite links are created when you ask Envoy to set up a meeting
              with a specific person (e.g. &ldquo;set up a 30-min intro with sarah@acme.com about the
              Q2 roadmap&rdquo;). They carry the context and rules for that one meeting.
            </div>
          ) : (
            <div className="space-y-2">
              {contextualLinks.map((link) => {
                const url = `${baseUrl}/meet/${link.slug}/${link.code ?? ""}`;
                const active = link.sessions.filter((s) => s.status === "active").length;
                const agreed = link.sessions.filter((s) => s.status === "agreed").length;
                return (
                  <div
                    key={link.id}
                    className="rounded-lg border border-DEFAULT bg-surface-secondary p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {link.topic || "Meeting"}
                          {link.inviteeName && (
                            <span className="text-muted font-normal"> — {link.inviteeName}</span>
                          )}
                        </div>
                        <div className="text-xs text-muted">
                          {link.inviteeEmail || "no invitee email"}
                          {agreed > 0 && (
                            <span className="text-emerald-400 ml-2">✓ {agreed} confirmed</span>
                          )}
                          {active > 0 && (
                            <span className="text-amber-400 ml-2">● {active} in progress</span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-purple-300 mt-1 break-all">
                          {url}
                        </div>
                      </div>
                      <CopyLinkButton url={url} compact />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  since,
  tone = "default",
}: {
  label: string;
  value: number;
  since: string;
  tone?: "default" | "emerald" | "amber" | "muted";
}) {
  const valueColor =
    tone === "emerald"
      ? "text-emerald-300"
      : tone === "amber"
        ? "text-amber-300"
        : tone === "muted"
          ? "text-muted"
          : "text-primary";
  return (
    <div className="rounded-lg border border-DEFAULT bg-surface-secondary/60 p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${valueColor}`}>{value}</div>
      <div className="text-[10px] text-muted mt-0.5">last {since}</div>
    </div>
  );
}
