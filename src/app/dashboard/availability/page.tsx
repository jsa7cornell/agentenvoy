"use client";

import { useSession, signIn } from "next-auth/react";
import { useEffect, useState, useCallback } from "react";
import { WeeklyCalendar, TunerEvent, TunerSlot } from "@/components/weekly-calendar";
import { DayView } from "@/components/day-view";
import { AvailabilityRules } from "@/components/availability-rules";
import Link from "next/link";

type SessionSummary = {
  id: string;
  status: string;
  archived: boolean;
  title: string | null;
  agreedTime: string | null;
  agreedFormat: string | null;
  duration: number | null;
  meetLink: string | null;
  guestEmail: string | null;
  guestName: string | null;
  dealRoomUrl: string;
};

function getSunday(d: Date): string {
  const date = new Date(d);
  const day = date.getDay();
  date.setDate(date.getDate() - day);
  return date.toISOString().slice(0, 10);
}

function formatWeekRange(weekStart: string): string {
  const start = new Date(weekStart + "T12:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} \u2013 ${fmt(end)}, ${start.getFullYear()}`;
}

export default function AvailabilityPage() {
  const { status } = useSession();

  const [weekStart, setWeekStart] = useState(() => getSunday(new Date()));
  const [events, setEvents] = useState<TunerEvent[]>([]);
  const [slots, setSlots] = useState<TunerSlot[]>([]);
  const [locationByDay, setLocationByDay] = useState<Record<string, string | null>>({});
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [connected, setConnected] = useState(false);
  const [calendars, setCalendars] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Event click modal state
  const [clickedEvent, setClickedEvent] = useState<TunerEvent | null>(null);
  const [clickedSession, setClickedSession] = useState<SessionSummary | null | undefined>(undefined); // undefined=loading, null=not a session
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // Protection override state for external (non-AgentEnvoy) events
  const [protectionSaving, setProtectionSaving] = useState(false);
  // Local optimistic override score for the clicked event (synced from event.protectionOverride)
  const [localProtection, setLocalProtection] = useState<number | null | undefined>(undefined);

  async function handleEventClick(ev: TunerEvent) {
    setClickedEvent(ev);
    setClickedSession(undefined); // loading
    setConfirmingCancel(false);
    // Seed local protection from what the schedule API already surfaced
    setLocalProtection(ev.protectionOverride !== undefined ? ev.protectionOverride : null);
    try {
      const res = await fetch(`/api/negotiate/by-calendar-event?eventId=${encodeURIComponent(ev.id)}`);
      const data = res.ok ? await res.json() : null;
      setClickedSession(data?.session ?? null);
    } catch {
      setClickedSession(null);
    }
  }

  async function handleProtectionChange(eventId: string, score: 0 | 3 | 5 | null) {
    setProtectionSaving(true);
    // Optimistic update
    setLocalProtection(score);
    try {
      await fetch("/api/tuner/event-protection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, score }),
      });
      // Refresh schedule so the heatmap reflects the new protection
      await fetchSchedule();
    } catch {
      // Revert on error
      setLocalProtection(clickedEvent?.protectionOverride !== undefined ? clickedEvent.protectionOverride : null);
    } finally {
      setProtectionSaving(false);
    }
  }

  async function handleSessionArchive(sessionId: string) {
    setSessionActionBusy(true);
    try {
      await fetch("/api/negotiate/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, archived: true }),
      });
      setClickedEvent(null);
      setClickedSession(undefined);
      await fetchSchedule(); // refresh calendar to remove the hold
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function handleSessionCancel(sessionId: string) {
    setSessionActionBusy(true);
    try {
      const res = await fetch("/api/negotiate/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        setClickedEvent(null);
        setClickedSession(undefined);
        setConfirmingCancel(false);
        await fetchSchedule(); // refresh calendar — confirmed event is now gone
      }
    } finally {
      setSessionActionBusy(false);
    }
  }

  // Calendar filter modal state
  const [calendarFilterModal, setCalendarFilterModal] = useState(false);
  const [googleCalendars, setGoogleCalendars] = useState<Array<{ id: string; name: string; primary: boolean; backgroundColor: string | null }>>([]);
  const [modalSelectedIds, setModalSelectedIds] = useState<string[]>([]);
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([]);
  const [activeCalendarIdsLoaded, setActiveCalendarIdsLoaded] = useState(false);
  const [pendingCalendarFilter, setPendingCalendarFilter] = useState(false);
  const [savingCalendarFilter, setSavingCalendarFilter] = useState(false);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [calendarsError, setCalendarsError] = useState<
    | null
    | { kind: "reconnect"; message: string }
    | { kind: "generic"; message: string }
  >(null);

  const loadGoogleCalendars = useCallback(async () => {
    setCalendarsLoading(true);
    setCalendarsError(null);
    try {
      const res = await fetch("/api/connections/google-calendars");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401 && data?.error === "reconnect_required") {
          setCalendarsError({
            kind: "reconnect",
            message:
              "Your Google connection has expired. Sign in again to restore calendar access.",
          });
        } else {
          setCalendarsError({
            kind: "generic",
            message: data?.detail || data?.error || `Request failed (${res.status})`,
          });
        }
        return;
      }
      if (!Array.isArray(data?.calendars)) {
        setCalendarsError({ kind: "generic", message: "Unexpected response from server." });
        return;
      }
      setGoogleCalendars(data.calendars);
      const ids = data.calendars.map((c: { id: string }) => c.id);
      setModalSelectedIds(activeCalendarIds.length > 0 ? activeCalendarIds : ids);
    } catch (err) {
      setCalendarsError({
        kind: "generic",
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setCalendarsLoading(false);
    }
  }, [activeCalendarIds]);

  function openCalendarFilter() {
    setCalendarFilterModal(true);
    if (googleCalendars.length === 0) {
      loadGoogleCalendars();
    } else {
      setModalSelectedIds(
        activeCalendarIds.length > 0 ? activeCalendarIds : googleCalendars.map((c) => c.id),
      );
    }
  }


  // Fetch activeCalendarIds once on mount
  useEffect(() => {
    fetch("/api/agent/knowledge")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.activeCalendarIds) setActiveCalendarIds(data.activeCalendarIds);
      })
      .catch(() => {})
      .finally(() => setActiveCalendarIdsLoaded(true));
  }, []);

  // Deep-link: `?manageCalendars=1` opens the calendar filter modal on mount.
  // Used by the Did You Know card's "Manage calendars" CTA. We clean the URL
  // immediately so a reload doesn't re-trigger the modal.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("manageCalendars") === "1") {
      setPendingCalendarFilter(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("manageCalendars");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  // When the deep-link is pending and `activeCalendarIds` has loaded,
  // open the modal. Waiting for the knowledge fetch ensures the modal
  // opens with the user's actual saved selection, not "all checked".
  useEffect(() => {
    if (!pendingCalendarFilter || !activeCalendarIdsLoaded) return;
    setPendingCalendarFilter(false);
    setCalendarFilterModal(true);
    if (googleCalendars.length === 0) {
      loadGoogleCalendars();
    } else {
      setModalSelectedIds(
        activeCalendarIds.length > 0 ? activeCalendarIds : googleCalendars.map((c) => c.id),
      );
    }
  }, [pendingCalendarFilter, activeCalendarIdsLoaded, loadGoogleCalendars, googleCalendars, activeCalendarIds]);

  const fetchSchedule = useCallback(async () => {
    try {
      const res = await fetch(`/api/tuner/schedule?weekStart=${weekStart}`);
      if (!res.ok) return;
      const data = await res.json();
      setEvents(data.events || []);
      setSlots(data.slots || []);
      setLocationByDay(data.locationByDay || {});
      setTimezone(data.timezone || "America/Los_Angeles");
      setConnected(data.connected ?? false);
      setCalendars(data.calendars || []);
    } catch (e) {
      console.error("Failed to fetch tuner schedule:", e);
    } finally {
      setIsLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    if (status !== "authenticated") return;
    setIsLoading(true);
    fetchSchedule();
  }, [status, fetchSchedule]);

  // Week navigation — allow 4 weeks back, 12 weeks forward
  const thisWeek = getSunday(new Date());
  const minWeekStart = (() => {
    const d = new Date(thisWeek + "T12:00:00");
    d.setDate(d.getDate() - 28);
    return d.toISOString().slice(0, 10);
  })();
  const maxWeekStart = (() => {
    const d = new Date(thisWeek + "T12:00:00");
    d.setDate(d.getDate() + 84);
    return d.toISOString().slice(0, 10);
  })();
  const canGoPrev = weekStart > minWeekStart;
  const canGoNext = weekStart < maxWeekStart;

  function shiftWeek(dir: number) {
    const d = new Date(weekStart + "T12:00:00");
    d.setDate(d.getDate() + 7 * dir);
    const next = d.toISOString().slice(0, 10);
    if (dir < 0 && next < minWeekStart) return;
    if (dir > 0 && next > maxWeekStart) return;
    setWeekStart(next);
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await fetch("/api/debug/force-resync", { method: "POST" });
      await fetchSchedule();
    } catch (e) {
      console.error("Refresh failed:", e);
    } finally {
      setIsRefreshing(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-muted">
          <p className="text-sm">Calendar not connected.</p>
          <p className="text-xs mt-1">
            Connect Google Calendar from{" "}
            <Link href="/dashboard/account" className="underline hover:text-secondary transition">
              your account
            </Link>{" "}
            to view availability.
          </p>
        </div>
      </div>
    );
  }

  // Week navigation bar (shared between layouts)
  const weekNav = (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-secondary shrink-0">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => shiftWeek(-1)}
          disabled={!canGoPrev}
          className="px-1.5 py-0.5 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          &larr;
        </button>
        <span className="text-xs text-primary text-center font-medium">
          {formatWeekRange(weekStart)}
        </span>
        <button
          onClick={() => shiftWeek(1)}
          disabled={!canGoNext}
          className="px-1.5 py-0.5 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          &rarr;
        </button>
        {weekStart !== thisWeek && (
          <button
            onClick={() => setWeekStart(thisWeek)}
            className="text-[10px] text-muted hover:text-secondary underline transition"
          >
            Today
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={openCalendarFilter}
          className="text-[11px] text-muted hover:text-secondary underline transition"
        >
          Manage calendars
        </button>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="flex items-center gap-1 px-2 py-1 text-xs text-secondary hover:text-primary disabled:opacity-50 transition"
          title={isRefreshing ? "Syncing..." : "Refresh"}
        >
          <svg
            className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {isRefreshing && <span>Syncing...</span>}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* ── Desktop: side-by-side layout ── */}
      <div className="hidden md:flex flex-1 flex-row overflow-hidden">
        {/* Rules panel — left */}
        <div className="w-[400px] min-w-[340px] max-w-[440px] border-r border-secondary overflow-y-auto">
          <AvailabilityRules onSaved={fetchSchedule} />
        </div>

        {/* Calendar panel — right */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {weekNav}
          <div className="flex-1 min-h-0 overflow-hidden">
            <WeeklyCalendar
              events={events}
              slots={slots}
              locationByDay={locationByDay}
              timezone={timezone}
              weekStart={weekStart}
              primaryCalendar={calendars[0]}
              onEventClick={handleEventClick}
            />
          </div>
        </div>
      </div>

      {/* ── Mobile: rules then calendar ── */}
      <div className="flex md:hidden flex-1 flex-col overflow-y-auto">
        <AvailabilityRules onSaved={fetchSchedule} />

        <div className="border-t border-secondary">
          {weekNav}
          <div className="h-[480px] shrink-0">
            <DayView
              events={events}
              slots={slots}
              locationByDay={locationByDay}
              timezone={timezone}
              weekStart={weekStart}
              primaryCalendar={calendars[0]}
              onEventClick={handleEventClick}
            />
          </div>
        </div>
      </div>

      {/* Event detail modal */}
      {clickedEvent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => { setClickedEvent(null); setClickedSession(undefined); setConfirmingCancel(false); }}
        >
          <div
            className="bg-surface-inset border border-DEFAULT rounded-2xl p-5 w-full max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Event title + time */}
            <h3 className="text-sm font-semibold text-primary mb-1 truncate">{clickedEvent.summary}</h3>
            <p className="text-xs text-muted mb-3">
              {new Date(clickedEvent.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              {" · "}
              {new Date(clickedEvent.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone })}
              {" – "}
              {new Date(clickedEvent.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone, timeZoneName: "short" })}
            </p>

            {/* Session lookup spinner */}
            {clickedSession === undefined && (
              <p className="text-xs text-muted py-2">Looking up session…</p>
            )}

            {/* AgentEnvoy session details */}
            {clickedSession !== undefined && clickedSession !== null && (
              <div className="border-t border-secondary pt-3 mb-3 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400">AgentEnvoy</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                    clickedSession.status === "agreed" ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" :
                    clickedSession.status === "cancelled" ? "text-red-400 border-red-500/30" :
                    "text-zinc-400 border-zinc-700"
                  }`}>
                    {clickedSession.status === "agreed" ? "Confirmed" : clickedSession.status}
                  </span>
                </div>
                {clickedSession.guestName && (
                  <p className="text-xs text-secondary">With {clickedSession.guestName}{clickedSession.guestEmail ? ` (${clickedSession.guestEmail})` : ""}</p>
                )}
                <Link
                  href={clickedSession.dealRoomUrl}
                  className="inline-block text-xs text-indigo-400 hover:text-indigo-300 transition"
                  onClick={() => setClickedEvent(null)}
                >
                  Open deal room →
                </Link>
              </div>
            )}

            {/* External event — protection picker */}
            {clickedSession === null && clickedEvent && !clickedEvent.isAllDay && (
              <div className="border-t border-secondary pt-3 mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">
                  How should this affect scheduling?
                </p>
                {(() => {
                  // Compute the engine's auto score from overlapping slots.
                  // Only valid when no override is active — when an override exists
                  // the slots already reflect that score, not the original auto value.
                  const noOverride = clickedEvent.protectionOverride === undefined;
                  const overlappingSlots = noOverride
                    ? slots.filter(
                        (s) =>
                          new Date(s.start) < new Date(clickedEvent.end) &&
                          new Date(s.end) > new Date(clickedEvent.start)
                      )
                    : [];
                  const autoScore =
                    overlappingSlots.length > 0
                      ? Math.max(...overlappingSlots.map((s) => s.score))
                      : null;

                  // Score → color for the auto badge
                  const scoreBadgeColor =
                    autoScore === null ? "text-zinc-500" :
                    autoScore <= 1 ? "text-emerald-400" :
                    autoScore <= 2 ? "text-yellow-400" :
                    autoScore <= 3 ? "text-amber-400" :
                    autoScore <= 4 ? "text-orange-400" :
                    "text-red-400";

                  const options = [
                    {
                      label: "Auto",
                      score: null as null,
                      desc: noOverride && autoScore !== null
                        ? `Engine assigned this a ${autoScore} — confirmed meetings block, tentative events stretch, declined events are ignored.`
                        : "Engine reads the event — confirmed meetings block, tentative events stretch, declined events are ignored.",
                      color: "text-zinc-400 border-zinc-700 hover:border-zinc-500",
                    },
                    {
                      label: "Open",
                      score: 0 as const,
                      desc: "Treat this time as available. The event is ignored for scheduling purposes.",
                      color: "text-emerald-400 border-emerald-700 hover:border-emerald-500",
                    },
                    {
                      label: "VIP backup",
                      score: 3 as const,
                      desc: "Protected, but offered to VIP contacts as a last resort if no better times are available.",
                      color: "text-amber-400 border-amber-700 hover:border-amber-500",
                    },
                    {
                      label: "Hard block",
                      score: 5 as const,
                      desc: "Never offered — not even to VIPs. This time is fully off-limits.",
                      color: "text-red-400 border-red-800 hover:border-red-600",
                    },
                  ];
                  const active = options.find((o) =>
                    o.score === null ? localProtection === null : localProtection === o.score
                  );
                  return (
                    <>
                      <div className="grid grid-cols-4 gap-1.5">
                        {options.map(({ label, score, color }) => {
                          const isActive =
                            score === null ? localProtection === null : localProtection === score;
                          const isAutoBtn = score === null;
                          return (
                            <button
                              key={label}
                              disabled={protectionSaving}
                              onClick={() => handleProtectionChange(clickedEvent.id, score as 0 | 3 | 5 | null)}
                              className={`flex flex-col items-center gap-0.5 px-1 py-2 rounded-lg border text-[10px] font-medium transition disabled:opacity-50 ${color} ${
                                isActive ? "bg-white/5 ring-1 ring-current" : "bg-transparent"
                              }`}
                            >
                              {label}
                              {/* Show engine-computed score badge on the Auto button when no override is active */}
                              {isAutoBtn && autoScore !== null && (
                                <span className={`text-[9px] font-bold tabular-nums leading-none ${scoreBadgeColor}`}>
                                  {autoScore}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      {active && (
                        <p className="text-[10px] text-muted mt-2 leading-relaxed">
                          {protectionSaving ? "Saving…" : active.desc}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {/* Actions */}
            {confirmingCancel && clickedSession ? (
              <div className="mt-1">
                <p className="text-xs text-secondary mb-3">Cancel this meeting? This will delete the Google Calendar event and notify all attendees.</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmingCancel(false)}
                    disabled={sessionActionBusy}
                    className="flex-1 px-3 py-2 text-xs text-secondary border border-secondary rounded-lg hover:border-DEFAULT transition disabled:opacity-50"
                  >
                    Keep it
                  </button>
                  <button
                    onClick={() => handleSessionCancel(clickedSession.id)}
                    disabled={sessionActionBusy}
                    className="flex-1 px-3 py-2 text-xs font-medium bg-red-900/40 text-red-300 border border-red-500/30 rounded-lg hover:bg-red-900/60 transition disabled:opacity-50"
                  >
                    {sessionActionBusy ? "Cancelling…" : "Yes, cancel"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 mt-1">
                <button
                  onClick={() => { setClickedEvent(null); setClickedSession(undefined); setConfirmingCancel(false); }}
                  className="flex-1 px-3 py-2 text-xs text-secondary border border-secondary rounded-lg hover:border-DEFAULT transition"
                >
                  Close
                </button>
                {clickedSession && !clickedSession.archived && clickedSession.status !== "cancelled" && (
                  <>
                    <button
                      onClick={() => handleSessionArchive(clickedSession.id)}
                      disabled={sessionActionBusy}
                      className="px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg hover:border-zinc-500 transition disabled:opacity-50"
                    >
                      {sessionActionBusy ? "…" : "Archive"}
                    </button>
                    {clickedSession.status === "agreed" && (
                      <button
                        onClick={() => setConfirmingCancel(true)}
                        className="px-3 py-2 text-xs text-red-400/70 hover:text-red-400 border border-red-500/20 rounded-lg hover:border-red-500/40 transition"
                      >
                        Cancel
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Calendar Filter Modal */}
      {calendarFilterModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => {
            setCalendarFilterModal(false);
            setCalendarsError(null);
          }}
        >
          <div
            className="bg-surface-inset border border-DEFAULT rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-primary mb-1">Which calendars affect your availability?</h3>
            <p className="text-xs text-muted mb-4">Only checked calendars will be used when scheduling.</p>
            {calendarsLoading ? (
              <div className="text-xs text-muted py-4 text-center">Loading calendars...</div>
            ) : calendarsError?.kind === "reconnect" ? (
              <div className="py-4 text-center space-y-3">
                <p className="text-xs text-muted">{calendarsError.message}</p>
                <button
                  onClick={() => signIn("google", { callbackUrl: "/dashboard/availability" })}
                  className="px-3 py-2 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition"
                >
                  Reconnect Google Calendar
                </button>
              </div>
            ) : calendarsError?.kind === "generic" ? (
              <div className="py-4 text-center space-y-3">
                <p className="text-xs text-red-400">Couldn&apos;t load calendars.</p>
                <p className="text-[10px] text-muted break-all">{calendarsError.message}</p>
                <button
                  onClick={loadGoogleCalendars}
                  className="px-3 py-2 text-xs font-medium text-primary border border-DEFAULT hover:border-surface-tertiary rounded-lg transition"
                >
                  Try again
                </button>
              </div>
            ) : googleCalendars.length === 0 ? (
              <div className="text-xs text-muted py-4 text-center">No calendars found.</div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Calendars</span>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setModalSelectedIds(googleCalendars.map((c) => c.id))}
                      className="text-[10px] text-muted hover:text-primary transition"
                    >
                      Select all
                    </button>
                    <button
                      onClick={() => setModalSelectedIds([])}
                      className="text-[10px] text-muted hover:text-primary transition"
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
                        <span className="text-sm text-primary truncate">
                          {cal.name}
                          {cal.primary && <span className="ml-1.5 text-[10px] text-muted">(primary)</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setCalendarFilterModal(false);
                  setCalendarsError(null);
                }}
                className="flex-1 px-3 py-2 text-xs font-medium text-secondary border border-DEFAULT rounded-lg hover:border-surface-tertiary transition"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setSavingCalendarFilter(true);
                  try {
                    const toSave = modalSelectedIds.length === googleCalendars.length ? [] : modalSelectedIds;
                    await fetch("/api/connections/calendar-filter", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ activeCalendarIds: toSave }),
                    });
                    setActiveCalendarIds(toSave);
                    setCalendarFilterModal(false);
                    // Refresh schedule to reflect new calendar selection
                    await handleRefresh();
                  } catch {
                    // ignore
                  } finally {
                    setSavingCalendarFilter(false);
                  }
                }}
                disabled={savingCalendarFilter || googleCalendars.length === 0}
                className="flex-1 px-3 py-2 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition disabled:opacity-40"
              >
                {savingCalendarFilter ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
