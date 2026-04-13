"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState, useCallback } from "react";
import { WeeklyCalendar, TunerEvent, TunerSlot } from "@/components/weekly-calendar";
import { DayView } from "@/components/day-view";
import { AvailabilityRules } from "@/components/availability-rules";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";

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
  const [mobileShowCalendar, setMobileShowCalendar] = useState(false);

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
            />
          </div>
        </div>
      </div>

      {/* ── Mobile: rules primary, calendar toggleable ── */}
      <div className="flex md:hidden flex-1 flex-col overflow-y-auto">
        {/* Rules panel — primary view */}
        <AvailabilityRules onSaved={fetchSchedule} />

        {/* Calendar toggle */}
        <div className="border-t border-secondary">
          <button
            onClick={() => setMobileShowCalendar(!mobileShowCalendar)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs text-secondary hover:text-primary transition"
          >
            {mobileShowCalendar ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                Hide Calendar Preview
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                Show Calendar Preview
              </>
            )}
          </button>
        </div>

        {/* Collapsible calendar */}
        {mobileShowCalendar && (
          <>
            {weekNav}
            <div className="h-[480px] shrink-0">
              <DayView
                events={events}
                slots={slots}
                locationByDay={locationByDay}
                timezone={timezone}
                weekStart={weekStart}
                primaryCalendar={calendars[0]}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
