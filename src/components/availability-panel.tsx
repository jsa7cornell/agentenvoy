"use client";

/**
 * Self-contained weekly availability panel. Owns schedule fetch, week
 * navigation, and the event-click override modal. Used by the standalone
 * /dashboard/availability page (as its right column) and embedded into the
 * main dashboard as a toggleable right-side accordion.
 *
 * Intentionally does NOT render the Rules or Calendar Filter panels — those
 * stay on the dedicated availability page only.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { WeeklyCalendar, TunerEvent, TunerSlot } from "@/components/weekly-calendar";
import { DayView } from "@/components/day-view";

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

export function getSunday(d: Date): string {
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

interface AvailabilityPanelProps {
  /** When true, render the mobile DayView instead of the full WeeklyCalendar.
   *  Used in narrow embeds (e.g. dashboard accordion on small screens) and
   *  on the mobile layout of /dashboard/availability. */
  forceMobile?: boolean;
  /** Header slot — rendered to the left of the week navigation controls.
   *  Used by the dashboard accordion to show a close button. */
  headerSlot?: React.ReactNode;
  /** Optional className on the outer wrapper. */
  className?: string;
}

export function AvailabilityPanel({
  forceMobile = false,
  headerSlot,
  className = "",
}: AvailabilityPanelProps) {
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
  const [clickedSession, setClickedSession] = useState<SessionSummary | null | undefined>(undefined);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [protectionSaving, setProtectionSaving] = useState(false);
  const [localProtection, setLocalProtection] = useState<number | null | undefined>(undefined);
  const [pendingProtection, setPendingProtection] = useState<number | null | undefined>(undefined);
  const [pendingScope, setPendingScope] = useState<"instance" | "series">("instance");
  const [localScope, setLocalScope] = useState<"instance" | "series">("instance");

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
    setIsLoading(true);
    fetchSchedule();
  }, [fetchSchedule]);

  async function handleEventClick(ev: TunerEvent) {
    setClickedEvent(ev);
    setClickedSession(undefined);
    setConfirmingCancel(false);
    const seed = ev.protectionOverride !== undefined ? ev.protectionOverride : null;
    setLocalProtection(seed);
    setPendingProtection(seed);
    const scopeSeed = ev.protectionOverrideScope ?? "instance";
    setLocalScope(scopeSeed);
    setPendingScope(scopeSeed);
    try {
      const res = await fetch(`/api/negotiate/by-calendar-event?eventId=${encodeURIComponent(ev.id)}&eventStart=${encodeURIComponent(ev.start)}`);
      const data = res.ok ? await res.json() : null;
      setClickedSession(data?.session ?? null);
    } catch {
      setClickedSession(null);
    }
  }

  async function handleProtectionChange(
    eventId: string,
    score: 0 | 3 | 5 | null,
    scope: "instance" | "series" = "instance"
  ) {
    setProtectionSaving(true);
    setLocalProtection(score);
    setLocalScope(scope);
    try {
      await fetch("/api/tuner/event-protection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, score, scope }),
      });
      await fetchSchedule();
    } catch {
      setLocalProtection(clickedEvent?.protectionOverride !== undefined ? clickedEvent.protectionOverride : null);
      setLocalScope(clickedEvent?.protectionOverrideScope ?? "instance");
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
      await fetchSchedule();
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
      <div className={`flex-1 flex items-center justify-center ${className}`}>
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className={`flex-1 flex items-center justify-center ${className}`}>
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

  const weekNav = (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-secondary shrink-0">
      <div className="flex items-center gap-1.5 min-w-0">
        {headerSlot}
        <button
          onClick={() => shiftWeek(-1)}
          disabled={!canGoPrev}
          className="px-1.5 py-0.5 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          &larr;
        </button>
        <span className="text-xs text-primary text-center font-medium truncate">
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
    <div className={`flex-1 min-w-0 flex flex-col overflow-hidden ${className}`}>
      {weekNav}
      <div className="flex-1 min-h-0 overflow-hidden">
        {forceMobile ? (
          <DayView
            events={events}
            slots={slots}
            locationByDay={locationByDay}
            timezone={timezone}
            weekStart={weekStart}
            primaryCalendar={calendars[0]}
            onEventClick={handleEventClick}
          />
        ) : (
          <WeeklyCalendar
            events={events}
            slots={slots}
            locationByDay={locationByDay}
            timezone={timezone}
            weekStart={weekStart}
            primaryCalendar={calendars[0]}
            onEventClick={handleEventClick}
          />
        )}
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
            <h3 className="text-sm font-semibold text-primary mb-1 truncate">{clickedEvent.summary}</h3>
            <p className="text-xs text-muted mb-3">
              {new Date(clickedEvent.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              {" · "}
              {new Date(clickedEvent.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone })}
              {" – "}
              {new Date(clickedEvent.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone, timeZoneName: "short" })}
            </p>

            {clickedSession === undefined && (
              <p className="text-xs text-muted py-2">Looking up session…</p>
            )}

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

            {clickedSession === null && clickedEvent && (
              <div className="border-t border-secondary pt-3 mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">
                  How should this affect scheduling?
                </p>
                {(() => {
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

                  function mapToLevel(score: number): 0 | 3 | 5 {
                    if (score <= 1) return 0;
                    if (score <= 3) return 3;
                    return 5;
                  }

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

                      {clickedEvent?.recurringEventId && pendingProtection !== null && (
                        <div className="mt-3 border-t border-secondary pt-3">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">
                            Apply to
                          </p>
                          <div className="flex flex-col gap-1.5">
                            <label className="flex items-start gap-2 text-[11px] text-secondary cursor-pointer">
                              <input
                                type="radio"
                                name="override-scope"
                                className="mt-0.5"
                                checked={pendingScope === "instance"}
                                onChange={() => setPendingScope("instance")}
                                disabled={protectionSaving}
                              />
                              <span>Just this event</span>
                            </label>
                            <label className="flex items-start gap-2 text-[11px] text-secondary cursor-pointer">
                              <input
                                type="radio"
                                name="override-scope"
                                className="mt-0.5"
                                checked={pendingScope === "series"}
                                onChange={() => setPendingScope("series")}
                                disabled={protectionSaving}
                              />
                              <span>All instances of this meeting going forward</span>
                            </label>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

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
                  const hasUnsaved =
                    clickedEvent !== null &&
                    (pendingProtection !== localProtection ||
                      (pendingProtection !== null && pendingScope !== localScope));
                  const saveEventId =
                    clickedEvent && pendingScope === "series" && clickedEvent.recurringEventId
                      ? clickedEvent.recurringEventId
                      : clickedEvent?.id;
                  const onPrimary = hasUnsaved && clickedEvent && saveEventId
                    ? async () => {
                        await handleProtectionChange(
                          saveEventId,
                          (pendingProtection as 0 | 3 | 5 | null),
                          pendingScope
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
    </div>
  );
}
