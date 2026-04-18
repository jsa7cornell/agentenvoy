"use client";

import { useSession, signIn } from "next-auth/react";
import { useEffect, useState, useCallback, useMemo } from "react";
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

type GoogleCalendar = { id: string; name: string; primary: boolean; backgroundColor: string | null };

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

// ─── Inline calendar filter panel ────────────────────────────────────────────

function CalendarFilterPanel({
  googleCalendars,
  modalSelectedIds,
  setModalSelectedIds,
  activeCalendarIds,
  calendarsLoading,
  calendarsError,
  savingCalendarFilter,
  onSave,
  onRetry,
}: {
  googleCalendars: GoogleCalendar[];
  modalSelectedIds: string[];
  setModalSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  activeCalendarIds: string[];
  calendarsLoading: boolean;
  calendarsError: null | { kind: "reconnect"; message: string } | { kind: "generic"; message: string };
  savingCalendarFilter: boolean;
  onSave: () => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(true);

  // Sort: primary first, then alphabetical
  const sorted = useMemo(
    () => [...googleCalendars].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)),
    [googleCalendars],
  );

  // Detect unsaved changes
  const activeCount = activeCalendarIds.length === 0 ? googleCalendars.length : activeCalendarIds.length;
  const hasChanges = useMemo(() => {
    const norm = (ids: string[]) =>
      (ids.length === googleCalendars.length ? [] : [...ids]).sort().join(",");
    return norm(modalSelectedIds) !== norm(activeCalendarIds);
  }, [modalSelectedIds, activeCalendarIds, googleCalendars.length]);

  const selectedCount = modalSelectedIds.length;
  const totalCount = googleCalendars.length;

  return (
    <div className="border-t border-secondary">
      {/* Collapsible header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-secondary transition text-left"
      >
        <span className="text-[11px] font-bold uppercase tracking-widest text-muted">
          Calendars
        </span>
        <div className="flex items-center gap-2">
          {!calendarsLoading && googleCalendars.length > 0 && (
            <span className="text-[10px] text-muted">
              {activeCount === totalCount ? "All active" : `${activeCount} of ${totalCount} active`}
            </span>
          )}
          <svg
            className={`w-3 h-3 text-muted transition-transform ${open ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4">
          {calendarsLoading ? (
            <p className="text-xs text-muted py-3 text-center">Loading calendars…</p>
          ) : calendarsError?.kind === "reconnect" ? (
            <div className="py-3 space-y-2 text-center">
              <p className="text-xs text-muted">{calendarsError.message}</p>
              <button
                onClick={() => signIn("google", { callbackUrl: "/dashboard/availability" })}
                className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition"
              >
                Reconnect Google Calendar
              </button>
            </div>
          ) : calendarsError?.kind === "generic" ? (
            <div className="py-3 space-y-2 text-center">
              <p className="text-xs text-red-400">Couldn&apos;t load calendars.</p>
              <p className="text-[10px] text-muted break-all">{calendarsError.message}</p>
              <button
                onClick={onRetry}
                className="px-3 py-1.5 text-xs font-medium text-primary border border-DEFAULT hover:border-surface-tertiary rounded-lg transition"
              >
                Try again
              </button>
            </div>
          ) : googleCalendars.length === 0 ? (
            <p className="text-xs text-muted py-3 text-center">No calendars found.</p>
          ) : (
            <>
              {/* Select all / none */}
              <div className="flex items-center justify-between mb-2 pt-1">
                <span className="text-[10px] text-muted">
                  {selectedCount} of {totalCount} selected
                </span>
                <div className="flex gap-3">
                  <button
                    onClick={() => setModalSelectedIds(googleCalendars.map((c) => c.id))}
                    className="text-[10px] text-muted hover:text-primary transition"
                  >
                    All
                  </button>
                  <button
                    onClick={() => setModalSelectedIds([])}
                    className="text-[10px] text-muted hover:text-primary transition"
                  >
                    None
                  </button>
                </div>
              </div>

              {/* Calendar list — show up to 8, scroll beyond */}
              <ul className="space-y-0.5 mb-3 max-h-[224px] overflow-y-auto">
                {sorted.map((cal) => (
                  <li key={cal.id}>
                    <label className="flex items-center gap-2.5 cursor-pointer py-1 rounded hover:bg-surface-secondary px-1 -mx-1 transition">
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
                        className="w-3.5 h-3.5 rounded accent-purple-500 flex-shrink-0"
                      />
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: cal.backgroundColor || "#6366f1" }}
                      />
                      <span className="text-xs text-primary truncate flex-1">
                        {cal.name}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              {/* Save button — only enabled when there are changes */}
              <button
                onClick={onSave}
                disabled={!hasChanges || savingCalendarFilter}
                className="w-full px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {savingCalendarFilter ? "Saving…" : hasChanges ? "Save changes" : "Saved"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

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
  // Staged-but-not-submitted selection. Separate from localProtection so the
  // user can preview options and only persist via Submit. Mirror of
  // localProtection's type. When pending !== local, the Close button flips
  // to "Submit".
  const [pendingProtection, setPendingProtection] = useState<number | null | undefined>(undefined);

  async function handleEventClick(ev: TunerEvent) {
    setClickedEvent(ev);
    setClickedSession(undefined); // loading
    setConfirmingCancel(false);
    // Seed local protection from what the schedule API already surfaced
    const seed = ev.protectionOverride !== undefined ? ev.protectionOverride : null;
    setLocalProtection(seed);
    setPendingProtection(seed);
    try {
      const res = await fetch(`/api/negotiate/by-calendar-event?eventId=${encodeURIComponent(ev.id)}&eventStart=${encodeURIComponent(ev.start)}`);
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
        await fetchSchedule();
      }
    } finally {
      setSessionActionBusy(false);
    }
  }

  // Calendar filter state
  const [googleCalendars, setGoogleCalendars] = useState<GoogleCalendar[]>([]);
  const [modalSelectedIds, setModalSelectedIds] = useState<string[]>([]);
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([]);
  const [activeCalendarIdsLoaded, setActiveCalendarIdsLoaded] = useState(false);
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
      setModalSelectedIds((prev) => prev.length > 0 ? prev : (activeCalendarIds.length > 0 ? activeCalendarIds : ids));
    } catch (err) {
      setCalendarsError({
        kind: "generic",
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setCalendarsLoading(false);
    }
  }, [activeCalendarIds]);

  const saveCalendarFilter = useCallback(async () => {
    setSavingCalendarFilter(true);
    try {
      const toSave = modalSelectedIds.length === googleCalendars.length ? [] : modalSelectedIds;
      await fetch("/api/connections/calendar-filter", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeCalendarIds: toSave }),
      });
      setActiveCalendarIds(toSave);
      await handleRefresh();
    } catch {
      // ignore
    } finally {
      setSavingCalendarFilter(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalSelectedIds, googleCalendars.length]);

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

  // Auto-load calendar list once active IDs are known
  useEffect(() => {
    if (!activeCalendarIdsLoaded) return;
    loadGoogleCalendars();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCalendarIdsLoaded]);

  // Deep-link: `?manageCalendars=1` — section is now always visible, just clean URL
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("manageCalendars") === "1") {
      const url = new URL(window.location.href);
      url.searchParams.delete("manageCalendars");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

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

  // Shared calendar filter panel props
  const calendarPanelProps = {
    googleCalendars,
    modalSelectedIds,
    setModalSelectedIds,
    activeCalendarIds,
    calendarsLoading,
    calendarsError,
    savingCalendarFilter,
    onSave: saveCalendarFilter,
    onRetry: loadGoogleCalendars,
  };

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
        <div className="w-[400px] min-w-[340px] max-w-[440px] border-r border-secondary overflow-y-auto flex flex-col">
          <AvailabilityRules onSaved={fetchSchedule} />
          <CalendarFilterPanel {...calendarPanelProps} />
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
        <CalendarFilterPanel {...calendarPanelProps} />

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
            {clickedSession === null && clickedEvent && (
              <div className="border-t border-secondary pt-3 mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">
                  How should this affect scheduling?
                </p>
                {(() => {
                  // Engine's auto score from overlapping slots — only valid when no
                  // override is active (slots reflect override when one is set).
                  const hasOverride = localProtection !== null;
                  const overlappingSlots = !hasOverride
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

                  // Map any 0-5 score to the nearest of our 3 explicit levels
                  function mapToLevel(score: number): 0 | 3 | 5 {
                    if (score <= 1) return 0;
                    if (score <= 3) return 3;
                    return 5;
                  }

                  // Visual selection prefers the staged (pending) choice so
                  // buttons reflect what the user just clicked, falling back
                  // to the persisted override, then the engine's auto score.
                  const hasPending = pendingProtection !== null && pendingProtection !== undefined;
                  const effectiveScore =
                    hasPending
                      ? (pendingProtection as 0 | 3 | 5)
                      : hasOverride
                      ? (localProtection as 0 | 3 | 5)
                      : autoScore !== null
                      ? mapToLevel(autoScore)
                      : 0;
                  const visualScore: 0 | 3 | 5 = effectiveScore;

                  const options: {
                    label: string;
                    score: 0 | 3 | 5;
                    desc: string;
                    activeClass: string;
                    inactiveClass: string;
                  }[] = [
                    {
                      label: "Open",
                      score: 0,
                      desc: "This time is treated as available. The event won't block scheduling.",
                      activeClass: "bg-emerald-500/20 border-2 border-emerald-400 text-emerald-600 dark:text-emerald-300 font-semibold",
                      inactiveClass: "border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:border-emerald-300 dark:hover:border-emerald-800 hover:text-emerald-600 dark:hover:text-emerald-400",
                    },
                    {
                      label: "Protected",
                      score: 3,
                      desc: "This time is held back from most requests. VIP contacts can still be offered it as a backup if nothing else works.",
                      activeClass: "bg-amber-500/20 border-2 border-amber-400 text-amber-600 dark:text-amber-300 font-semibold",
                      inactiveClass: "border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:border-amber-300 dark:hover:border-amber-800 hover:text-amber-600 dark:hover:text-amber-400",
                    },
                    {
                      label: "Blocked",
                      score: 5,
                      desc: "Fully off-limits. This time will never be offered, not even to VIPs.",
                      activeClass: "bg-red-500/20 border-2 border-red-400 text-red-600 dark:text-red-300 font-semibold",
                      inactiveClass: "border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:border-red-300 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-400",
                    },
                  ];

                  const activeOption = options.find((o) => o.score === visualScore) ?? options[0];

                  // Auto label for the reset link
                  const autoLevelLabel =
                    autoScore !== null
                      ? options.find((o) => o.score === mapToLevel(autoScore))?.label
                      : null;

                  return (
                    <>
                      <div className="grid grid-cols-3 gap-2">
                        {options.map(({ label, score, activeClass, inactiveClass }) => {
                          const isActive = score === visualScore;
                          return (
                            <button
                              key={label}
                              disabled={protectionSaving}
                              onClick={() => setPendingProtection(score)}
                              className={`px-2 py-2.5 rounded-lg text-[11px] transition disabled:opacity-50 ${
                                isActive ? activeClass : inactiveClass
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>

                      <p className="text-[10px] text-muted mt-2 leading-relaxed">
                        {protectionSaving ? "Saving…" : activeOption.desc}
                      </p>

                      {/* Let Envoy decide — stages a reset to engine-auto,
                          persisted on Submit. Only shown when the CURRENT
                          state (saved or staged) is an override. */}
                      {(hasOverride || hasPending) && (
                        <p className="text-[10px] text-muted mt-1.5">
                          <button
                            disabled={protectionSaving}
                            onClick={() => setPendingProtection(null)}
                            className="underline hover:text-secondary transition disabled:opacity-50"
                          >
                            Let Envoy decide.
                          </button>
                          {autoLevelLabel && (
                            <span className="ml-1">(engine would pick: {autoLevelLabel})</span>
                          )}
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
                <p className="text-xs text-secondary mb-3">
                  {clickedSession.status === "agreed"
                    ? <>Cancel this meeting? The Google Calendar invite will be deleted and{" "}{clickedSession.guestName || "your guest"} will be notified.</>
                    : <>Stop this negotiation? The session will be closed and {clickedSession.guestName || "your guest"} won&apos;t receive a new meeting.</>}
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setConfirmingCancel(false)} disabled={sessionActionBusy}
                    className="flex-1 px-3 py-2 text-xs text-secondary border border-secondary rounded-lg hover:border-DEFAULT transition disabled:opacity-50">
                    Keep it
                  </button>
                  <button
                    onClick={() => clickedSession.status === "agreed" ? handleSessionCancel(clickedSession.id) : handleSessionArchive(clickedSession.id)}
                    disabled={sessionActionBusy}
                    className="flex-1 px-3 py-2 text-xs font-medium bg-red-900/40 text-red-300 border border-red-500/30 rounded-lg hover:bg-red-900/60 transition disabled:opacity-50">
                    {sessionActionBusy ? "Cancelling…" : "Yes, cancel"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 mt-1">
                {(() => {
                  // The Open/Protected/Blocked/Let-Envoy-decide picker stages
                  // changes into pendingProtection. If it differs from the
                  // persisted value, the primary button flips to "Submit" and
                  // saves on click. Otherwise it's just a dismiss.
                  const hasUnsaved =
                    clickedEvent !== null &&
                    pendingProtection !== localProtection;
                  const onPrimary = hasUnsaved && clickedEvent
                    ? async () => {
                        await handleProtectionChange(
                          clickedEvent.id,
                          (pendingProtection as 0 | 3 | 5 | null)
                        );
                        setClickedEvent(null);
                        setClickedSession(undefined);
                        setConfirmingCancel(false);
                      }
                    : () => {
                        setClickedEvent(null);
                        setClickedSession(undefined);
                        setConfirmingCancel(false);
                      };
                  return (
                    <button
                      onClick={onPrimary}
                      disabled={protectionSaving}
                      className={
                        hasUnsaved
                          ? "flex-1 px-3 py-2 text-xs font-semibold bg-indigo-500/90 hover:bg-indigo-500 text-white rounded-lg transition disabled:opacity-50"
                          : "flex-1 px-3 py-2 text-xs text-secondary border border-secondary rounded-lg hover:border-DEFAULT transition disabled:opacity-50"
                      }
                    >
                      {protectionSaving ? "Saving…" : hasUnsaved ? "Submit" : "Close"}
                    </button>
                  );
                })()}
                {clickedSession && !clickedSession.archived && clickedSession.status !== "cancelled" && (
                  <button
                    onClick={() => setConfirmingCancel(true)}
                    className="px-3 py-2 text-xs text-red-400 hover:text-red-300 border border-red-500/30 rounded-lg hover:border-red-500/60 transition"
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
