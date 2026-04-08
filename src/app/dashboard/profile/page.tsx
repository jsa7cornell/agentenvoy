"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo } from "react";
import { DashboardHeader } from "@/components/dashboard-header";
import { AvailabilityCalendar } from "@/components/availability-calendar";
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
  upcomingSchedulePreferences: string;
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
    <span className="relative inline-flex items-center ml-1.5 translate-y-px">
      <button
        onClick={() => setOpen(!open)}
        className="w-3.5 h-3.5 rounded-full bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-300 transition inline-flex items-center justify-center text-[9px] font-bold"
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

// --- Bullet display for preferences ---
function BulletDisplay({ text, placeholder, onClick }: { text: string; placeholder: string; onClick: () => void }) {
  // Split by newlines first; if that yields a single block, split by sentence boundaries
  let lines = text.split("\n").filter((l) => l.trim());
  if (lines.length <= 1 && text.trim()) {
    lines = text
      .split(/(?<=\.)\s+/)
      .filter((l) => l.trim());
  }
  if (lines.length === 0) {
    return (
      <button
        onClick={onClick}
        className="w-full text-left text-sm text-zinc-600 italic py-2 hover:text-zinc-400 transition"
      >
        {placeholder}
      </button>
    );
  }
  return (
    <button onClick={onClick} className="w-full text-left group">
      <ul className="space-y-1.5">
        {lines.map((line, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
            <span className="text-zinc-600 mt-0.5">&#x2022;</span>
            <span>{line.trim()}</span>
          </li>
        ))}
        <li className="flex items-start gap-2 text-sm text-zinc-700 group-hover:text-zinc-600 transition">
          <span className="mt-0.5">&#x2022;</span>
          <span className="italic">Add a note...</span>
        </li>
      </ul>
    </button>
  );
}

export default function ProfilePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);
  const [, setKnowledge] = useState<KnowledgeState | null>(null);
  const [persistent, setPersistent] = useState("");
  const [situational, setSituational] = useState("");
  const [savedPersistent, setSavedPersistent] = useState("");
  const [savedSituational, setSavedSituational] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [calendarModal, setCalendarModal] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [calendarFilterModal, setCalendarFilterModal] = useState(false);
  const [googleCalendars, setGoogleCalendars] = useState<Array<{ id: string; name: string; primary: boolean; backgroundColor: string | null }>>([]);
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([]);
  // modalSelectedIds is the working selection inside the modal (always explicit, never empty-means-all)
  const [modalSelectedIds, setModalSelectedIds] = useState<string[]>([]);
  const [savingCalendarFilter, setSavingCalendarFilter] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [editingGeneral, setEditingGeneral] = useState(false);
  const [calendarView, setCalendarView] = useState<"guest" | "all">("guest");
  const [ambiguities, setAmbiguities] = useState<string[]>([]);

  // Availability calendar state
  const [slotsByDay, setSlotsByDay] = useState<Record<string, Array<{ start: string; end: string; score?: number }>>>({});
  const [slotTimezone, setSlotTimezone] = useState("America/Los_Angeles");
  const [slotLocation, setSlotLocation] = useState<{ label: string; until?: string } | null>(null);

  const fetchSlots = useCallback(() => {
    fetch("/api/negotiate/slots?self=true")
      .then((res) => res.json())
      .then((data) => {
        if (data.slotsByDay) setSlotsByDay(data.slotsByDay);
        if (data.timezone) setSlotTimezone(data.timezone);
        if (data.currentLocation) setSlotLocation(data.currentLocation);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;

    fetch("/api/connections/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setConnStatus(data); })
      .catch(() => {});

    fetch("/api/agent/knowledge")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setKnowledge(data);
          setPersistent(data.persistentKnowledge);
          setSituational(data.upcomingSchedulePreferences);
          setSavedPersistent(data.persistentKnowledge);
          setSavedSituational(data.upcomingSchedulePreferences);
          if (data.ambiguities?.length) setAmbiguities(data.ambiguities);
          if (data.activeCalendarIds) setActiveCalendarIds(data.activeCalendarIds);
        }
      })
      .catch(() => {});

    fetch("/api/negotiate/sessions?archived=false")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.sessions) {
          const now = new Date();
          const pastIds: string[] = [];

          const sorted = [...data.sessions]
            .sort((a: ActiveSession, b: ActiveSession) => {
              const aConfirmed = a.status === "agreed" ? 0 : 1;
              const bConfirmed = b.status === "agreed" ? 0 : 1;
              if (aConfirmed !== bConfirmed) return aConfirmed - bConfirmed;
              const dateA = a.agreedTime || a.createdAt;
              const dateB = b.agreedTime || b.createdAt;
              return new Date(dateA).getTime() - new Date(dateB).getTime();
            })
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

          // Fire-and-forget auto-archive for past/expired sessions
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
      .finally(() => setSessionsLoading(false));

    fetchSlots();
  }, [status, fetchSlots]);

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
          upcomingSchedulePreferences: situational,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSaveMessage("Saved");
        setSavedPersistent(persistent);
        setSavedSituational(situational);
        setEditingSchedule(false);
        setEditingGeneral(false);
        setAmbiguities(data.ambiguities ?? []);
        fetchSlots();
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

  // Filter slots for guest view: hide score 3+ (friction/protected/immovable)
  const filteredSlotsByDay = useMemo(() => {
    if (calendarView === "all") return slotsByDay;
    const filtered: Record<string, Array<{ start: string; end: string; score?: number }>> = {};
    for (const [day, slots] of Object.entries(slotsByDay)) {
      const guestSlots = slots.filter((s) => (s.score ?? 1) <= 2);
      if (guestSlots.length > 0) filtered[day] = guestSlots;
    }
    return filtered;
  }, [slotsByDay, calendarView]);

  if (status === "loading" || !session) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  const calendarWidget = (
    <>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
          Availability
        </h4>
        <div className="flex rounded-full bg-zinc-800 p-0.5">
          <button
            onClick={() => setCalendarView("guest")}
            className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium transition ${
              calendarView === "guest"
                ? "bg-zinc-600 text-zinc-100 shadow-sm"
                : "text-zinc-500 hover:text-zinc-400"
            }`}
          >
            Guest
          </button>
          <button
            onClick={() => setCalendarView("all")}
            className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium transition ${
              calendarView === "all"
                ? "bg-zinc-600 text-zinc-100 shadow-sm"
                : "text-zinc-500 hover:text-zinc-400"
            }`}
          >
            All
          </button>
        </div>
      </div>
      <AvailabilityCalendar
        slotsByDay={filteredSlotsByDay}
        timezone={slotTimezone}
        currentLocation={slotLocation}
      />
      <p className="text-[10px] text-zinc-600 mt-2">Update your schedule preferences to change your availability.</p>
    </>
  );

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100 flex flex-col">
      <DashboardHeader />

      <div className="flex-1 flex overflow-hidden">
        {/* Main content column */}
        <div className="flex-1 overflow-y-auto">
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

            {/* Connections — horizontal scroll row */}
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 mb-3">
                Connections
              </h2>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {/* Google Calendar */}
                <div className={`flex flex-col rounded-xl flex-shrink-0 w-36 overflow-hidden border transition ${
                  calendarConnected
                    ? "bg-emerald-900/10 border-emerald-700/30"
                    : "bg-zinc-900/50 border-zinc-800"
                }`}>
                  <button
                    onClick={() => {
                      if (calendarConnected) {
                        setCalendarModal(true);
                      } else {
                        signIn("google", { callbackUrl: "/dashboard/profile" });
                      }
                    }}
                    className="flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-white/5 transition"
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
                  {calendarConnected && (
                    <button
                      onClick={() => {
                        if (googleCalendars.length === 0) {
                          fetch("/api/connections/google-calendars")
                            .then((r) => r.json())
                            .then((d) => {
                              if (d.calendars) {
                                setGoogleCalendars(d.calendars);
                                // Initialize modal selection: expand [] (all) to explicit list
                                const ids = d.calendars.map((c: { id: string }) => c.id);
                                setModalSelectedIds(activeCalendarIds.length > 0 ? activeCalendarIds : ids);
                              }
                            })
                            .catch(() => {});
                        } else {
                          // Calendars already loaded, just sync modal state
                          setModalSelectedIds(activeCalendarIds.length > 0 ? activeCalendarIds : googleCalendars.map((c) => c.id));
                        }
                        setCalendarFilterModal(true);
                      }}
                      className="px-3 py-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 border-t border-emerald-800/30 text-left transition hover:bg-white/5"
                    >
                      Manage calendars
                    </button>
                  )}
                </div>

                {/* Other Calendars */}
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-zinc-900/50 border border-zinc-800 opacity-50 flex-shrink-0 w-36">
                  <div className="w-7 h-7 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
                    <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-400">Other</div>
                    <div className="text-[10px] text-zinc-600">Soon</div>
                  </div>
                </div>

                {/* AI Agent placeholders */}
                {[1, 2, 3].map((n) => (
                  <div key={n} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-zinc-900/50 border border-zinc-800 opacity-50 flex-shrink-0 w-36">
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
            </section>

            {/* Mobile-only availability calendar */}
            <section className="md:hidden">
              <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
                {calendarWidget}
              </div>
            </section>

            {/* Preferences — unified section */}
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 mb-3">
                Preferences
              </h2>
              <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl divide-y divide-zinc-800/60">
                {/* Schedule sub-area */}
                <div className="p-4">
                  <div className="flex items-baseline mb-2">
                    <span className="text-xs font-semibold text-zinc-400">Schedule</span>
                    <InfoBubble text="Tell Envoy about anything coming up that affects your availability — travel, events, time off, schedule changes. This helps your agent make smarter scheduling decisions." />
                  </div>
                  {editingSchedule ? (
                    <textarea
                      value={situational}
                      onChange={(e) => setSituational(e.target.value)}
                      autoFocus
                      rows={4}
                      placeholder={"e.g.\n- In Mexico next week — no morning meetings\n- Training for a race this month, 7am calls are fine\n- Out of office Apr 10-12"}
                      className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-purple-500/50 transition resize-y min-h-[80px]"
                    />
                  ) : (
                    <BulletDisplay
                      text={situational}
                      placeholder="Click to add schedule context..."
                      onClick={() => setEditingSchedule(true)}
                    />
                  )}
                </div>

                {/* General sub-area */}
                <div className="p-4">
                  <div className="flex items-baseline mb-2">
                    <span className="text-xs font-semibold text-zinc-400">General</span>
                    <InfoBubble text="Long-term preferences that rarely change — how you like to meet, your default format, buffer time between meetings. Your agent reads this on every negotiation." />
                  </div>
                  {editingGeneral ? (
                    <textarea
                      value={persistent}
                      onChange={(e) => setPersistent(e.target.value)}
                      autoFocus
                      rows={6}
                      placeholder={"e.g.\n- Default timezone: America/Los_Angeles\n- I prefer mornings for calls\n- Budget 30 min travel for in-person meetings\n- Stack calls on MWF"}
                      className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-purple-500/50 transition resize-y min-h-[100px]"
                    />
                  ) : (
                    <BulletDisplay
                      text={persistent}
                      placeholder="Click to add general preferences..."
                      onClick={() => setEditingGeneral(true)}
                    />
                  )}
                </div>
              </div>

              {/* Save button — only shown when changes are pending */}
              {(() => {
                const isDirty = persistent !== savedPersistent || situational !== savedSituational;
                return (
                  <div className={`flex items-center justify-end gap-2 mt-3 transition-opacity duration-200 ${isDirty ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                    {saveMessage && (
                      <span className={`text-xs ${saveMessage === "Saved" ? "text-emerald-400" : "text-red-400"}`}>
                        {saveMessage}
                      </span>
                    )}
                    <button
                      onClick={handleSaveKnowledge}
                      disabled={saving}
                      className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-30 text-white text-sm rounded-lg font-medium transition"
                    >
                      {saving ? "Saving..." : "Save preferences"}
                    </button>
                  </div>
                );
              })()}

              {/* Ambiguity warnings */}
              {ambiguities.length > 0 && (
                <div className="mt-3 rounded-lg bg-amber-950/30 border border-amber-900/40 px-4 py-3">
                  <p className="text-[11px] font-semibold text-amber-400 mb-1.5">
                    Envoy couldn&apos;t fully interpret some preferences — please clarify when you get a chance:
                  </p>
                  <ul className="space-y-1">
                    {ambiguities.map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-amber-300/80">
                        <span className="mt-0.5">&#x2022;</span>
                        <span>{a}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
                    const statusDisplay: Record<string, { label: string; bg: string; text: string }> = {
                      agreed: { label: "Confirmed", bg: "bg-green-500/10", text: "text-green-400" },
                      proposed: { label: "Proposed", bg: "bg-amber-500/10", text: "text-amber-400" },
                      active: { label: "Pending", bg: "bg-amber-500/10", text: "text-amber-400" },
                      cancelled: { label: "Cancelled", bg: "bg-red-500/10", text: "text-red-400" },
                      escalated: { label: "Escalated", bg: "bg-orange-500/10", text: "text-orange-400" },
                    };
                    const sd = statusDisplay[s.status] || statusDisplay.active;
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
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-zinc-200 truncate">{title}</div>
                          <div className="text-xs text-zinc-500 truncate">
                            {s.statusLabel || guestLabel}
                          </div>
                        </div>
                        <span
                          className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${sd.bg} ${sd.text}`}
                        >
                          {sd.label}
                        </span>
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
        </div>

        {/* Desktop sidebar — availability calendar */}
        <div className="hidden md:flex w-72 flex-shrink-0 border-l border-zinc-800 p-4 overflow-y-auto flex-col">
          {calendarWidget}
        </div>
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

      {/* Calendar Filter Modal */}
      {calendarFilterModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setCalendarFilterModal(false)}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-zinc-100 mb-1">Which calendars affect your availability?</h3>
            <p className="text-xs text-zinc-500 mb-4">Only checked calendars will be used when scheduling.</p>

            {googleCalendars.length === 0 ? (
              <div className="text-xs text-zinc-500 py-4 text-center">Loading calendars...</div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Calendars</span>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setModalSelectedIds(googleCalendars.map((c) => c.id))}
                      className="text-[10px] text-zinc-500 hover:text-zinc-200 transition"
                    >
                      Select all
                    </button>
                    <button
                      onClick={() => setModalSelectedIds([])}
                      className="text-[10px] text-zinc-500 hover:text-zinc-200 transition"
                    >
                      Select none
                    </button>
                  </div>
                </div>
                <ul className="space-y-2 mb-5 max-h-64 overflow-y-auto">
                  {googleCalendars.map((cal) => (
                    <li key={cal.id}>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={modalSelectedIds.includes(cal.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setModalSelectedIds((prev) => [...prev, cal.id]);
                            } else {
                              setModalSelectedIds((prev) => prev.filter((id) => id !== cal.id));
                            }
                          }}
                          className="w-4 h-4 rounded accent-purple-500"
                        />
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: cal.backgroundColor || "#6366f1" }}
                        />
                        <span className="text-sm text-zinc-300 truncate">
                          {cal.name}
                          {cal.primary && <span className="ml-1.5 text-[10px] text-zinc-500">(primary)</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setCalendarFilterModal(false)}
                className="flex-1 px-3 py-2 text-xs font-medium text-zinc-400 border border-zinc-700 rounded-lg hover:border-zinc-600 transition"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setSavingCalendarFilter(true);
                  try {
                    // If all calendars selected, save as [] (= use all, backward compat)
                    const toSave = modalSelectedIds.length === googleCalendars.length ? [] : modalSelectedIds;
                    await fetch("/api/connections/calendar-filter", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ activeCalendarIds: toSave }),
                    });
                    setActiveCalendarIds(toSave);
                    setCalendarFilterModal(false);
                    fetchSlots();
                  } catch {
                    // ignore
                  } finally {
                    setSavingCalendarFilter(false);
                  }
                }}
                disabled={savingCalendarFilter || googleCalendars.length === 0}
                className="flex-1 px-3 py-2 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-lg transition disabled:opacity-40"
              >
                {savingCalendarFilter ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
