"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DashboardHeader } from "@/components/dashboard-header";
import Link from "next/link";

interface ConnectionStatus {
  google: {
    connected: boolean;
    calendar: boolean;
    scopes: string[];
  };
}

interface KnowledgeState {
  persistentKnowledge: string;
  situationalKnowledge: string;
  preview: string;
}

interface ActiveSession {
  id: string;
  title?: string;
  status: string;
  statusLabel?: string;
  format?: string;
  duration?: number;
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
  _count: { messages: number };
}

// --- Info Bubble component ---
function InfoBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block ml-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="w-4 h-4 rounded-full bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-300 transition inline-flex items-center justify-center text-[9px] font-bold"
      >
        i
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-1/2 -translate-x-1/2 top-6 z-50 w-64 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 shadow-xl">
            {text}
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-zinc-800 border-l border-t border-zinc-700 rotate-45" />
          </div>
        </>
      )}
    </span>
  );
}

export default function ProfilePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);
  const [, setKnowledge] = useState<KnowledgeState | null>(null);
  const [persistent, setPersistent] = useState("");
  const [situational, setSituational] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [calendarModal, setCalendarModal] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  useEffect(() => {
    fetch("/api/connections/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setConnStatus(data); })
      .catch(() => {});

    fetch("/api/agent/knowledge")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: KnowledgeState | null) => {
        if (data) {
          setKnowledge(data);
          setPersistent(data.persistentKnowledge);
          setSituational(data.situationalKnowledge);
        }
      })
      .catch(() => {});

    fetch("/api/negotiate/sessions?archived=false")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.sessions) {
          // Sort by nearest date first (agreedTime for confirmed, createdAt for pending)
          const sorted = [...data.sessions].sort((a: ActiveSession, b: ActiveSession) => {
            const dateA = a.agreedTime || a.createdAt;
            const dateB = b.agreedTime || b.createdAt;
            return new Date(dateA).getTime() - new Date(dateB).getTime();
          });
          setActiveSessions(sorted);
        }
      })
      .catch(() => {})
      .finally(() => setSessionsLoading(false));
  }, []);

  const calendarConnected = connStatus?.google?.calendar ?? false;

  async function handleSaveKnowledge() {
    if (saving) return;
    setSaving(true);
    setSaveMessage("");
    try {
      const res = await fetch("/api/agent/knowledge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          persistentKnowledge: persistent,
          situationalKnowledge: situational,
        }),
      });
      if (res.ok) {
        setSaveMessage("Saved");
        setTimeout(() => setSaveMessage(""), 2000);
      } else {
        setSaveMessage("Failed to save");
      }
    } catch {
      setSaveMessage("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnectCalendar() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/connections/disconnect-calendar", { method: "POST" });
      if (res.ok) {
        setConnStatus((prev) =>
          prev ? { ...prev, google: { ...prev.google, calendar: false, scopes: [] } } : prev
        );
        setCalendarModal(false);
      }
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  }

  function getDealRoomUrl(s: ActiveSession) {
    return s.link.code ? `/meet/${s.link.slug}/${s.link.code}` : `/meet/${s.link.slug}`;
  }

  if (status === "loading" || !session) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100 flex flex-col">
      <DashboardHeader />

      <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-8 space-y-8">
        {/* Profile Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {session.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={session.user.image} alt="" className="w-12 h-12 rounded-full" />
            ) : (
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
                <span className="text-lg font-bold text-white">
                  {session.user?.name?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
            )}
            <div>
              <h1 className="text-lg font-semibold">{session.user?.name}</h1>
              <p className="text-sm text-zinc-500">{session.user?.email}</p>
            </div>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition"
          >
            Sign out
          </button>
        </div>

        {/* Connections — moved to top */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 mb-3">
            Connections
          </h2>
          <div className="space-y-3">
            {/* Row 1: Calendars */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600 mb-1.5">Calendars</div>
              <div className="grid grid-cols-2 gap-2">
                {/* Google Calendar */}
                <button
                  onClick={() => {
                    if (calendarConnected) {
                      setCalendarModal(true);
                    } else {
                      signIn("google", { callbackUrl: "/dashboard/profile" });
                    }
                  }}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition ${
                    calendarConnected
                      ? "bg-emerald-900/10 border border-emerald-700/30 hover:border-emerald-600/50"
                      : "bg-zinc-900/50 border border-zinc-800 hover:border-zinc-700"
                  }`}
                >
                  <div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center flex-shrink-0">
                    <svg viewBox="0 0 24 24" className="w-4 h-4">
                      <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                      <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                      <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                      <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                      <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                      <path d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z" fill="#1967D2" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-200">Google</div>
                    <div className={`text-[10px] ${calendarConnected ? "text-emerald-400" : "text-zinc-600"}`}>
                      {calendarConnected ? "Connected" : "Connect"}
                    </div>
                  </div>
                </button>

                {/* Other Calendars */}
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-zinc-900/50 border border-zinc-800 opacity-50">
                  <div className="w-7 h-7 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
                    <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-400">Other</div>
                    <div className="text-[10px] text-zinc-600">Coming soon</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Row 2: AI Agents */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600 mb-1.5">AI Agents</div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-zinc-900/50 border border-zinc-800 opacity-50">
                    <div className="w-7 h-7 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
                      <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082" />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-zinc-400">Agent {n}</div>
                      <div className="text-[10px] text-zinc-600">Soon</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Things Envoy Should Know About Your Upcoming Schedule */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
                Upcoming Schedule Context
              </h2>
              <InfoBubble text="Tell Envoy about anything coming up that affects your availability — travel, events, time off, schedule changes. This helps your agent make smarter scheduling decisions." />
            </div>
            <div className="flex items-center gap-2">
              {saveMessage && (
                <span className={`text-xs ${saveMessage === "Saved" ? "text-emerald-400" : "text-red-400"}`}>
                  {saveMessage}
                </span>
              )}
              <button
                onClick={handleSaveKnowledge}
                disabled={saving}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-30 text-white text-xs rounded-lg font-medium transition"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <textarea
              value={situational}
              onChange={(e) => setSituational(e.target.value)}
              rows={4}
              placeholder="e.g. In Mexico next week — no morning meetings. Training for a race this month, 7am calls are fine. Out of office Apr 10-12."
              className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-purple-500/50 transition resize-y min-h-[80px]"
            />
          </div>
        </section>

        {/* General Preferences */}
        <section>
          <div className="flex items-center mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              General Preferences
            </h2>
            <InfoBubble text="Long-term preferences that rarely change — how you like to meet, your default format, buffer time between meetings. Your agent reads this on every negotiation." />
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <textarea
              value={persistent}
              onChange={(e) => setPersistent(e.target.value)}
              rows={6}
              placeholder="e.g. I prefer mornings for calls. Budget 30 min travel for in-person meetings. I like to stack calls on MWF."
              className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-purple-500/50 transition resize-y min-h-[100px]"
            />
          </div>
        </section>

        {/* Active Meetings */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 mb-3">
            Active Meetings
          </h2>
          {sessionsLoading ? (
            <div className="text-center py-6 text-zinc-600 text-sm">Loading...</div>
          ) : activeSessions.length === 0 ? (
            <div className="text-center py-6 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <p className="text-sm text-zinc-500">No active meetings</p>
            </div>
          ) : (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden divide-y divide-zinc-800/60">
              {activeSessions.map((s) => {
                const isConfirmed = s.status === "agreed";
                const displayDate = isConfirmed && s.agreedTime
                  ? new Date(s.agreedTime).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  : `Created ${new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
                const guestLabel = s.link.inviteeName || s.guestEmail || s.link.inviteeEmail || "Guest";
                const title = s.title || s.link.topic || `Meeting with ${guestLabel}`;

                return (
                  <Link
                    key={s.id}
                    href={getDealRoomUrl(s)}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-800/40 transition"
                  >
                    {/* Title + guest */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-zinc-200 truncate">{title}</div>
                      <div className="text-xs text-zinc-500 truncate">{guestLabel}</div>
                    </div>

                    {/* Status badge */}
                    <span
                      className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                        isConfirmed
                          ? "bg-green-500/10 text-green-400"
                          : "bg-amber-500/10 text-amber-400"
                      }`}
                    >
                      {isConfirmed ? "Confirmed" : "Pending"}
                    </span>

                    {/* Date */}
                    <span className="flex-shrink-0 text-xs text-zinc-500 w-20 text-right">
                      {displayDate}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* Archived Meetings */}
        <section>
          <Link
            href="/dashboard/archive"
            className="flex items-center justify-between bg-zinc-900/50 border border-zinc-800 rounded-xl px-4 py-3.5 hover:border-zinc-700 transition group"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
              <span className="text-sm text-zinc-300">Archived meetings</span>
            </div>
            <span className="text-xs text-zinc-600 group-hover:text-zinc-400 transition">
              View &rarr;
            </span>
          </Link>
        </section>
      </div>

      {/* Google Calendar Modal */}
      {calendarModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setCalendarModal(false)}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-6 h-6">
                  <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                  <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                  <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                  <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                  <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                  <path d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z" fill="#1967D2" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Google Calendar</h3>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-xs text-emerald-400">Connected</span>
                </div>
              </div>
            </div>

            <div className="space-y-2 mb-5">
              <div className="bg-zinc-800/60 rounded-lg px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Access</div>
                <p className="text-xs text-zinc-300">Read calendar events and create meetings on your behalf</p>
              </div>
              <div className="bg-zinc-800/60 rounded-lg px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Account</div>
                <p className="text-xs text-zinc-300">{session.user?.email}</p>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setCalendarModal(false)}
                className="flex-1 px-3 py-2 text-xs font-medium text-zinc-400 border border-zinc-700 rounded-lg hover:border-zinc-600 transition"
              >
                Close
              </button>
              <button
                onClick={handleDisconnectCalendar}
                disabled={disconnecting}
                className="flex-1 px-3 py-2 text-xs font-medium text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition disabled:opacity-50"
              >
                {disconnecting ? "Disconnecting..." : "Disconnect Calendar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
