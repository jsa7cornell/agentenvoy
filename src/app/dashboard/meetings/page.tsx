"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import Link from "next/link";

interface ActiveSession {
  id: string;
  title?: string;
  status: string;
  statusLabel?: string;
  agreedTime?: string;
  createdAt: string;
  guestEmail?: string;
  link: {
    type: string;
    slug: string;
    code?: string;
    inviteeName?: string;
    inviteeEmail?: string;
    topic?: string;
  };
}

function getDealRoomUrl(s: ActiveSession) {
  return s.link.code ? `/meet/${s.link.slug}/${s.link.code}` : `/meet/${s.link.slug}`;
}

const STATUS_DISPLAY: Record<string, { label: string; bg: string; text: string }> = {
  agreed: { label: "Confirmed", bg: "bg-green-500/10", text: "text-green-400" },
  proposed: { label: "Proposed", bg: "bg-amber-500/10", text: "text-amber-400" },
  active: { label: "Pending", bg: "bg-amber-500/10", text: "text-amber-400" },
  cancelled: { label: "Cancelled", bg: "bg-red-500/10", text: "text-red-400" },
  escalated: { label: "Escalated", bg: "bg-orange-500/10", text: "text-orange-400" },
};

export default function MeetingsPage() {
  const { status } = useSession();
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null); // sessionId awaiting confirm

  async function handleArchive(sessionId: string) {
    setArchiving(sessionId);
    try {
      const res = await fetch("/api/negotiate/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, archived: true }),
      });
      if (res.ok) {
        setActiveSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }
    } catch {
      // silently fail
    } finally {
      setArchiving(null);
    }
  }

  async function handleCancel(sessionId: string) {
    setCancelling(sessionId);
    try {
      const res = await fetch("/api/negotiate/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        setActiveSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }
    } catch {
      // silently fail
    } finally {
      setCancelling(null);
      setConfirmCancel(null);
    }
  }

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/negotiate/sessions?archived=false")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.sessions) {
          const now = new Date();
          const pastIds: string[] = [];
          const sorted = [...data.sessions]
            .sort((a: ActiveSession, b: ActiveSession) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            )
            .filter((s: ActiveSession) => {
              const isPast = s.agreedTime && new Date(s.agreedTime) < now;
              const isExpired = s.status === "expired";
              if (isPast || isExpired) {
                pastIds.push(s.id);
                return false;
              }
              return true;
            });
          setActiveSessions(sorted);
          // Auto-archive past/expired
          pastIds.forEach((sessionId) => {
            fetch("/api/negotiate/archive", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, archived: true }),
            }).catch(() => {});
          });
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [status]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-8 space-y-6">
        {/* Active Meetings */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Active Meetings ({activeSessions.length})
          </h2>
          {activeSessions.length === 0 ? (
            <div className="bg-surface-inset/50 border border-secondary rounded-xl px-4 py-8 text-center">
              <p className="text-sm text-muted">No active meetings</p>
              <p className="text-xs text-muted mt-1">
                When someone starts scheduling with you, meetings will appear here.
              </p>
            </div>
          ) : (
            <div className="bg-surface-inset/50 border border-secondary rounded-xl overflow-hidden divide-y divide-secondary/60">
              {activeSessions.map((s) => {
                const sd = STATUS_DISPLAY[s.status] || STATUS_DISPLAY.active;
                const isConfirmed = s.status === "agreed";
                const displayDate = isConfirmed && s.agreedTime
                  ? new Date(s.agreedTime).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : `Created ${new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
                const guestLabel = s.link.inviteeName || s.guestEmail || s.link.inviteeEmail || "Guest";
                const title = s.title || s.link.topic || `Meeting with ${guestLabel}`;

                // Inline cancel confirm state for this row
                if (confirmCancel === s.id) {
                  return (
                    <div key={s.id} className="flex items-center gap-2 px-4 py-3 bg-red-950/20">
                      <span className="text-xs text-secondary flex-1">Cancel this meeting? Google Calendar invite will be deleted.</span>
                      <button
                        onClick={() => setConfirmCancel(null)}
                        className="text-xs text-muted hover:text-secondary transition px-2 py-1"
                      >Keep</button>
                      <button
                        onClick={(e) => { e.preventDefault(); handleCancel(s.id); }}
                        disabled={cancelling === s.id}
                        className="text-xs font-medium text-red-400 hover:text-red-300 border border-red-500/30 rounded px-2 py-1 transition disabled:opacity-50"
                      >{cancelling === s.id ? "Cancelling…" : "Yes, cancel"}</button>
                    </div>
                  );
                }

                return (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-secondary/40 transition">
                    <Link href={getDealRoomUrl(s)} className="flex-1 min-w-0 flex items-center gap-3 min-w-0">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-primary truncate">{title}</div>
                        <div className="text-xs text-muted truncate">{s.statusLabel || guestLabel}</div>
                      </div>
                      <span className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${sd.bg} ${sd.text}`}>
                        {sd.label}
                      </span>
                      <span className="flex-shrink-0 text-[10px] text-muted hidden sm:block">{displayDate}</span>
                    </Link>
                    {/* Cancel — confirmed sessions only */}
                    {isConfirmed && (
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmCancel(s.id); }}
                        title="Cancel meeting"
                        className="flex-shrink-0 text-[11px] text-red-500/60 hover:text-red-400 transition"
                      >
                        Cancel
                      </button>
                    )}
                    {/* Archive — all sessions */}
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleArchive(s.id); }}
                      disabled={archiving === s.id}
                      title="Archive"
                      className="flex-shrink-0 p-1.5 rounded-md text-zinc-600 hover:text-primary hover:bg-surface-secondary/60 transition disabled:opacity-50"
                    >
                      {archiving === s.id
                        ? <span className="text-[10px] text-muted">…</span>
                        : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                          </svg>
                      }
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Archived */}
        <Link
          href="/dashboard/archive"
          className="flex items-center justify-between bg-surface-inset/50 border border-secondary rounded-xl px-4 py-3 hover:border-DEFAULT transition group"
        >
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
            <span className="text-sm text-primary">Archived meetings</span>
          </div>
          <span className="text-xs text-muted group-hover:text-secondary transition">View &rarr;</span>
        </Link>
      </div>
    </div>
  );
}
