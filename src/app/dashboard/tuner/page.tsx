"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { DashboardHeader } from "@/components/dashboard-header";
import { WeeklyCalendar, TunerEvent, TunerSlot } from "@/components/weekly-calendar";
import { PreferencePanel } from "@/components/preference-panel";

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

export default function TunerPage() {
  const { status } = useSession();
  const router = useRouter();

  const [weekStart, setWeekStart] = useState(() => getSunday(new Date()));
  const [events, setEvents] = useState<TunerEvent[]>([]);
  const [slots, setSlots] = useState<TunerSlot[]>([]);
  const [locationByDay, setLocationByDay] = useState<Record<string, string | null>>({});
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [connected, setConnected] = useState(false);
  const [calendars, setCalendars] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

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

  // Week navigation — up to 8 weeks out (matches scoring horizon)
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

  if (status === "loading" || isLoading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 bg-surface flex flex-col overflow-hidden">
      <DashboardHeader />

      {/* Week navigation bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-secondary shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-primary">Availability Tuner</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => shiftWeek(-1)}
              disabled={!canGoPrev}
              className="px-2 py-1 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              &larr;
            </button>
            <span className="text-sm text-primary min-w-[160px] text-center">
              {formatWeekRange(weekStart)}
            </span>
            <button
              onClick={() => shiftWeek(1)}
              disabled={!canGoNext}
              className="px-2 py-1 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              &rarr;
            </button>
          </div>
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
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-secondary hover:text-primary border border-DEFAULT rounded-lg hover:border-surface-tertiary disabled:opacity-50 transition"
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

      {!connected ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-muted">
            <p className="text-sm">Calendar not connected.</p>
            <p className="text-xs mt-1">Connect Google Calendar from your profile to use the tuner.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Preference panel — left side (wider, ~1.75x ratio) */}
          <div className="flex-[1.75] min-w-[320px] max-w-[560px] border-r border-secondary flex flex-col min-h-0">
            <PreferencePanel onSaved={fetchSchedule} />
          </div>

          {/* Weekly calendar — right side */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <WeeklyCalendar
              events={events}
              slots={slots}
              locationByDay={locationByDay}
              timezone={timezone}
              weekStart={weekStart}
              primaryCalendar={calendars[0]}
            />
          </div>
        </div>
      )}
    </div>
  );
}
