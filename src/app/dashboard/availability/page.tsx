"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState, useCallback } from "react";
import { WeeklyCalendar, TunerEvent, TunerSlot } from "@/components/weekly-calendar";
import { DayView } from "@/components/day-view";
import { AvailabilityRules } from "@/components/availability-rules";
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

function getDealRoomUrl(s: ActiveSession) {
  return s.link.code ? `/meet/${s.link.slug}/${s.link.code}` : `/meet/${s.link.slug}`;
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

  // Active meetings
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

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

  // Fetch active sessions
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
  }, [status]);

  // Week navigation
  const thisWeek = getSunday(new Date());
  const maxWeekStart = (() => {
    const d = new Date(thisWeek + "T12:00:00");
    d.setDate(d.getDate() + 49);
    return d.toISOString().slice(0, 10);
  })();
  const canGoPrev = weekStart > thisWeek;
  const canGoNext = weekStart < maxWeekStart;

  function shiftWeek(dir: number) {
    const d = new Date(weekStart + "T12:00:00");
    d.setDate(d.getDate() + 7 * dir);
    const next = d.toISOString().slice(0, 10);
    if (dir < 0 && next < thisWeek) return;
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

  const statusDisplay: Record<string, { label: string; bg: string; text: string }> = {
    agreed: { label: "Confirmed", bg: "bg-green-500/10", text: "text-green-400" },
    proposed: { label: "Proposed", bg: "bg-amber-500/10", text: "text-amber-400" },
    active: { label: "Pending", bg: "bg-amber-500/10", text: "text-amber-400" },
    cancelled: { label: "Cancelled", bg: "bg-red-500/10", text: "text-red-400" },
    escalated: { label: "Escalated", bg: "bg-orange-500/10", text: "text-orange-400" },
  };

  const meetingsSection = (
    <div className="border-t border-secondary p-4 space-y-3">
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted">
        Active Meetings
      </h3>
      {sessionsLoading ? (
        <div className="text-xs text-muted">Loading...</div>
      ) : activeSessions.length === 0 ? (
        <div className="text-xs text-muted">No active meetings</div>
      ) : (
        <div className="bg-surface-inset/50 border border-secondary rounded-xl overflow-hidden divide-y divide-secondary/60">
          {activeSessions.map((s) => {
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
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-secondary/40 transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-primary truncate">{title}</div>
                  <div className="text-xs text-muted truncate">{s.statusLabel || guestLabel}</div>
                </div>
                <span className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${sd.bg} ${sd.text}`}>
                  {sd.label}
                </span>
                <span className="flex-shrink-0 text-[10px] text-muted">{displayDate}</span>
              </Link>
            );
          })}
        </div>
      )}
      <Link
        href="/dashboard/archive"
        className="flex items-center justify-between bg-surface-inset/50 border border-secondary rounded-xl px-3 py-2.5 hover:border-DEFAULT transition group"
      >
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
          </svg>
          <span className="text-xs text-primary">Archived meetings</span>
        </div>
        <span className="text-[10px] text-muted group-hover:text-secondary transition">View &rarr;</span>
      </Link>
    </div>
  );

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

  return (
    <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
      {/* Rules panel — left on desktop, below calendar on mobile */}
      <div className="order-2 md:order-1 md:w-[400px] md:min-w-[340px] md:max-w-[440px] md:border-r border-secondary overflow-y-auto">
        <AvailabilityRules onSaved={fetchSchedule} />
        {meetingsSection}
      </div>

      {/* Calendar panel — right on desktop, top on mobile */}
      <div className="order-1 md:order-2 flex-1 min-w-0 flex flex-col overflow-hidden border-b md:border-b-0 border-secondary">
        {/* Week navigation — desktop only (mobile uses the day-view strip) */}
        <div className="hidden md:flex items-center justify-between px-4 py-2 border-b border-secondary shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => shiftWeek(-1)}
              disabled={!canGoPrev}
              className="px-2 py-1 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              &larr;
            </button>
            <span className="text-sm text-primary min-w-[160px] text-center font-medium">
              {formatWeekRange(weekStart)}
            </span>
            <button
              onClick={() => shiftWeek(1)}
              disabled={!canGoNext}
              className="px-2 py-1 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              &rarr;
            </button>
            {weekStart !== thisWeek && (
              <button
                onClick={() => setWeekStart(thisWeek)}
                className="text-xs text-muted hover:text-secondary underline transition"
              >
                This week
              </button>
            )}
          </div>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-secondary hover:text-primary border border-DEFAULT rounded-lg hover:border-surface-tertiary disabled:opacity-50 transition"
          >
            <svg
              className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {isRefreshing ? "Syncing..." : "Refresh"}
          </button>
        </div>

        {/* Mobile: week nav bar + refresh */}
        <div className="flex md:hidden items-center justify-between px-3 py-1.5 border-b border-secondary shrink-0">
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
          </div>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-1.5 text-xs text-secondary hover:text-primary disabled:opacity-50 transition"
            title={isRefreshing ? "Syncing..." : "Refresh"}
          >
            <svg
              className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Desktop: Weekly calendar */}
        <div className="hidden md:flex flex-1 min-h-0 overflow-hidden">
          <WeeklyCalendar
            events={events}
            slots={slots}
            locationByDay={locationByDay}
            timezone={timezone}
            weekStart={weekStart}
            primaryCalendar={calendars[0]}
          />
        </div>

        {/* Mobile: Day view with strip picker */}
        <div className="flex md:hidden flex-1 min-h-0 overflow-hidden">
          <DayView
            events={events}
            slots={slots}
            locationByDay={locationByDay}
            timezone={timezone}
            weekStart={weekStart}
            primaryCalendar={calendars[0]}
          />
        </div>
      </div>
    </div>
  );
}
