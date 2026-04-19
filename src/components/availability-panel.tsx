"use client";

/**
 * Self-contained weekly availability panel. Owns schedule fetch, week
 * navigation, timezone picker, calendar filter (swatch strip + popover),
 * rules-management modal, and the event-click override modal.
 *
 * Used by the standalone /dashboard/availability page (as its right column)
 * and embedded into the main dashboard as the primary right pane.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { WeeklyCalendar, TunerEvent, TunerSlot } from "@/components/weekly-calendar";
import { DayView } from "@/components/day-view";
import { AvailabilityRules } from "@/components/availability-rules";
import { TIMEZONE_TABLE, shortTimezoneLabel, getTimezoneEntry } from "@/lib/timezone";

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

type GoogleCalendar = {
  id: string;
  name: string;
  primary: boolean;
  backgroundColor: string | null;
};

export function getSunday(d: Date): string {
  const date = new Date(d);
  const day = date.getDay();
  date.setDate(date.getDate() - day);
  return date.toISOString().slice(0, 10);
}

function formatWeekRange(weekStart: string, days: number): string {
  const start = new Date(weekStart + "T12:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + Math.max(0, days - 1));
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} \u2013 ${fmt(end)}, ${start.getFullYear()}`;
}

// Responsive day count — based on the panel's content width (not the viewport),
// so embeds in different hosts behave correctly.
function computeDaysToShow(width: number): number {
  if (width >= 780) return 7;
  if (width >= 560) return 5;
  return 3;
}

interface AvailabilityPanelProps {
  /** When true, force the mobile DayView instead of the WeeklyCalendar.
   *  Used in narrow embeds and on the mobile layout of /dashboard/availability. */
  forceMobile?: boolean;
  /** Header slot rendered to the left of week-nav controls. */
  headerSlot?: React.ReactNode;
  /** Optional className on the outer wrapper. */
  className?: string;
  /** Show the inline "Calendars" swatch strip + "Rules" button. Default true. */
  showControls?: boolean;
}

export function AvailabilityPanel({
  forceMobile = false,
  headerSlot,
  className = "",
  showControls = true,
}: AvailabilityPanelProps) {
  const [weekStart, setWeekStart] = useState(() => getSunday(new Date()));
  const [events, setEvents] = useState<TunerEvent[]>([]);
  const [slots, setSlots] = useState<TunerSlot[]>([]);
  const [locationByDay, setLocationByDay] = useState<Record<string, string | null>>({});
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [tzSaving, setTzSaving] = useState(false);
  const [connected, setConnected] = useState(false);
  const [calendars, setCalendars] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Mobile view toggle — Day / Work week (Mon–Fri) / Week (Sun–Sat). Only
  // used when forceMobile. Work week is the default.
  const [mobileView, setMobileView] = useState<"day" | "workweek" | "week">("workweek");
  // Desktop week-range toggle — full Sun-Sat vs. Mon-Fri workweek. Default full.
  const [weekRange, setWeekRange] = useState<"full" | "workweek">("full");

  // Responsive — measure panel content width, pick 3/5/7 day view.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [daysToShow, setDaysToShow] = useState(7);
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      setDaysToShow(computeDaysToShow(el.clientWidth));
    });
    ro.observe(el);
    setDaysToShow(computeDaysToShow(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // Anchor for the grid: when showing all 7 days, use Sunday (week start).
  // When < 7, anchor to today so the visible days are "today + next N-1".
  const gridStart = useMemo(() => {
    if (daysToShow >= 7) return weekStart;
    const today = new Date();
    return today.toISOString().slice(0, 10);
  }, [weekStart, daysToShow]);

  // Today anchor — used by mobile Day / Midweek views regardless of
  // container width, so the 3-day view always shows "today + next 2"
  // and doesn't drift to Sunday when the panel happens to be wide.
  // Doesn't depend on weekStart — the week-nav arrows only affect the
  // Week-view range; Day and Midweek always anchor on today.
  const todayAnchor = useMemo(() => {
    return new Date().toISOString().slice(0, 10);
  }, []);

  // Monday of the current week — used by mobile-week and desktop workweek
  // toggle to anchor a Mon–Fri view.
  const mondayAnchor = useMemo(() => {
    const d = new Date(weekStart + "T12:00:00");
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }, [weekStart]);

  // Desktop: user-selected week-range (full Sun-Sat vs. Mon-Fri workweek)
  // takes precedence over the responsive 3/5/7-day logic.
  const desktopAnchor = weekRange === "full" ? weekStart : mondayAnchor;
  const desktopDays = weekRange === "full" ? 7 : 5;

  // Rules modal
  const [rulesOpen, setRulesOpen] = useState(false);

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

  // Timezone picker
  async function handleTimezoneChange(tz: string) {
    const previous = timezone;
    setTimezone(tz);
    setTzSaving(true);
    try {
      const res = await fetch("/api/tuner/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: tz }),
      });
      if (!res.ok) throw new Error("save failed");
      await fetchSchedule();
    } catch {
      setTimezone(previous);
    } finally {
      setTzSaving(false);
    }
  }

  // Calendar picker
  const [googleCalendars, setGoogleCalendars] = useState<GoogleCalendar[]>([]);
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [calendarsError, setCalendarsError] = useState<
    | null
    | { kind: "reconnect"; message: string }
    | { kind: "generic"; message: string }
  >(null);
  const [savingCalendarFilter, setSavingCalendarFilter] = useState(false);
  const [calPickerOpen, setCalPickerOpen] = useState(false);

  const loadCalendars = useCallback(async () => {
    setCalendarsLoading(true);
    setCalendarsError(null);
    try {
      const res = await fetch("/api/connections/google-calendars");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401 && data?.error === "reconnect_required") {
          setCalendarsError({
            kind: "reconnect",
            message: "Your Google connection has expired. Sign in again to restore calendar access.",
          });
        } else {
          setCalendarsError({
            kind: "generic",
            message: data?.detail || data?.error || `Request failed (${res.status})`,
          });
        }
        return;
      }
      if (Array.isArray(data?.calendars)) {
        setGoogleCalendars(data.calendars);
      }
    } catch (err) {
      setCalendarsError({
        kind: "generic",
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setCalendarsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch active filter + calendar list on mount
    fetch("/api/agent/knowledge")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.activeCalendarIds) setActiveCalendarIds(data.activeCalendarIds);
      })
      .catch(() => {});
    loadCalendars();
  }, [loadCalendars]);

  async function toggleCalendarActive(id: string) {
    const sorted = [...googleCalendars].map((c) => c.id).sort();
    const currentActive =
      activeCalendarIds.length === 0 ? sorted : [...activeCalendarIds].sort();
    const isActive = currentActive.includes(id);
    const next = isActive ? currentActive.filter((x) => x !== id) : [...currentActive, id];
    // Normalize: all selected → empty array (meaning "all").
    const normalized = next.length === sorted.length ? [] : next;
    setSavingCalendarFilter(true);
    try {
      await fetch("/api/connections/calendar-filter", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeCalendarIds: normalized }),
      });
      setActiveCalendarIds(normalized);
      await fetch("/api/debug/force-resync", { method: "POST" });
      await fetchSchedule();
    } finally {
      setSavingCalendarFilter(false);
    }
  }

  function isCalendarActive(id: string): boolean {
    if (activeCalendarIds.length === 0) return true; // all active
    return activeCalendarIds.includes(id);
  }

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

  // Week navigation — 4 weeks back, 12 weeks forward
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
      <div ref={containerRef} className={`flex-1 flex items-center justify-center ${className}`}>
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div ref={containerRef} className={`flex-1 flex items-center justify-center ${className}`}>
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

  // Sort calendars: primary first, then alphabetical
  const sortedCalendars = [...googleCalendars].sort(
    (a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0),
  );

  // Top toolbar — 3-col grid so the week scroller stays centered regardless
  // of what's on either side.
  const weekNav = (
    <div
      className="grid items-center px-3 py-1.5 border-b border-secondary shrink-0 gap-2"
      style={{ gridTemplateColumns: "1fr auto 1fr" }}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {headerSlot}
      </div>
      <div className="flex items-center justify-center gap-1.5">
        <button
          onClick={() => shiftWeek(-1)}
          disabled={!canGoPrev}
          className="px-1.5 py-0.5 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          &larr;
        </button>
        <span className="text-xs text-primary text-center font-medium truncate">
          {formatWeekRange(
            forceMobile ? gridStart : desktopAnchor,
            forceMobile ? daysToShow : desktopDays,
          )}
        </span>
        <button
          onClick={() => shiftWeek(1)}
          disabled={!canGoNext}
          className="px-1.5 py-0.5 text-xs text-secondary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          &rarr;
        </button>
        <button
          onClick={() => setWeekStart(thisWeek)}
          disabled={weekStart === thisWeek}
          className="text-[10px] px-1.5 py-0.5 rounded border border-DEFAULT transition disabled:opacity-30 disabled:cursor-default text-secondary hover:text-primary hover:border-indigo-400 disabled:hover:border-DEFAULT disabled:hover:text-secondary"
          title="Go to current week"
        >
          Today
        </button>
      </div>
      <div className="flex items-center justify-end gap-2">
        {/* Desktop week-range toggle — Full (Sun-Sat) vs. Workweek (Mon-Fri) */}
        {!forceMobile && (
          <div className="hidden md:flex items-stretch rounded-md border border-DEFAULT overflow-hidden text-[10px] font-medium">
            <button
              onClick={() => setWeekRange("full")}
              className={`px-2 py-0.5 transition ${
                weekRange === "full"
                  ? "bg-indigo-500 text-white"
                  : "text-secondary hover:text-primary"
              }`}
              title="Sunday through Saturday"
            >
              Full week
            </button>
            <button
              onClick={() => setWeekRange("workweek")}
              className={`px-2 py-0.5 transition border-l border-DEFAULT ${
                weekRange === "workweek"
                  ? "bg-indigo-500 text-white"
                  : "text-secondary hover:text-primary"
              }`}
              title="Monday through Friday"
            >
              Workweek
            </button>
          </div>
        )}
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
        </button>
      </div>
    </div>
  );

  // TZ chip — rendered into the day-header gutter of WeeklyCalendar so it
  // sits on the "times" side of the grid. Subtle but clickable.
  const tzChip = (
    <div className="relative flex items-center gap-0.5" title={`Timezone: ${timezone}${tzSaving ? " (saving…)" : ""}`}>
      {/* Globe icon */}
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted flex-shrink-0" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" />
        <ellipse cx="8" cy="8" rx="2.5" ry="6.5" />
        <line x1="1.5" y1="8" x2="14.5" y2="8" />
      </svg>
      <select
        value={timezone}
        onChange={(e) => handleTimezoneChange(e.target.value)}
        disabled={tzSaving}
        className="appearance-none pl-0.5 pr-3 py-0 text-[10px] font-medium text-secondary hover:text-primary bg-transparent border-0 cursor-pointer focus:outline-none transition disabled:opacity-50 max-w-[48px]"
      >
        {TIMEZONE_TABLE.map((entry) => (
          <option key={entry.iana} value={entry.iana}>
            {shortTimezoneLabel(entry.iana)} — {entry.long}
          </option>
        ))}
        {!getTimezoneEntry(timezone) && (
          <option value={timezone}>{timezone} (custom)</option>
        )}
      </select>
      <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-[8px] text-muted">▾</span>
    </div>
  );

  // Score-legend chips — reused as the sub-day-chip strip on mobile and as
  // the left side of the desktop legendBar.
  const legendChips = (
    <div className="flex items-center gap-3 px-3 py-1 border-b border-secondary text-[10px] text-muted shrink-0 flex-wrap">
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-100 dark:bg-emerald-600/60 border border-emerald-500 dark:border-emerald-400" /> Available</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-teal-100 dark:bg-teal-600/70 border border-teal-500 dark:border-teal-400" /> Office</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-100 dark:bg-amber-600/50 border border-amber-500 dark:border-amber-400" /> Protected</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-100 dark:bg-red-600/50 border border-red-600 dark:border-red-500" /> Blocked</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-indigo-50 dark:bg-indigo-900/80 border border-indigo-500 dark:border-indigo-400" /> Event</span>
    </div>
  );

  // Desktop second-row toolbar — legend chips + right-aligned calendar picker & rules.
  const legendBar = (
    <div className="flex items-center gap-3 px-3 py-1.5 border-b border-secondary text-[10px] text-muted shrink-0 flex-wrap">
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-100 dark:bg-emerald-600/60 border border-emerald-500 dark:border-emerald-400" /> Available</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-teal-100 dark:bg-teal-600/70 border border-teal-500 dark:border-teal-400" /> Office</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-100 dark:bg-amber-600/50 border border-amber-500 dark:border-amber-400" /> Protected</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-100 dark:bg-red-600/50 border border-red-600 dark:border-red-500" /> Blocked</span>
      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-indigo-50 dark:bg-indigo-900/80 border border-indigo-500 dark:border-indigo-400" /> Event</span>

      {showControls && (
        <div className="ml-auto flex items-center gap-2">
          {/* Calendar picker — "Calendars" label + small colored boxes, Google-style */}
          <div className="relative flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] text-muted">
            <button
              onClick={() => setCalPickerOpen((o) => !o)}
              className="hover:text-primary transition"
              title="Manage calendars"
            >
              Calendars
            </button>
            <span className="flex items-center gap-[3px]">
              {sortedCalendars.slice(0, 6).map((c) => (
                <button
                  key={c.id}
                  onClick={(e) => { e.stopPropagation(); toggleCalendarActive(c.id); }}
                  disabled={savingCalendarFilter}
                  title={`${c.name}${c.primary ? " (primary)" : ""} — click to ${isCalendarActive(c.id) ? "hide" : "show"}`}
                  className={`w-2 h-2 rounded-sm border cursor-pointer hover:scale-125 transition disabled:opacity-50 ${isCalendarActive(c.id) ? "" : "opacity-25"}`}
                  style={{
                    backgroundColor: c.backgroundColor || "#6366f1",
                    borderColor: c.backgroundColor || "#6366f1",
                  }}
                />
              ))}
            </span>
            <button
              onClick={() => setCalPickerOpen((o) => !o)}
              className="hover:text-primary transition"
              title="Manage calendars"
            >
              ▾
            </button>
            {calPickerOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setCalPickerOpen(false)} />
                <div className="absolute right-0 mt-1 z-40 w-64 bg-surface-inset border border-DEFAULT rounded-lg shadow-xl p-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted px-1 pb-1.5">
                    Calendars
                  </p>
                  {calendarsLoading ? (
                    <p className="text-xs text-muted px-1 py-2">Loading…</p>
                  ) : calendarsError?.kind === "reconnect" ? (
                    <div className="px-1 py-2 space-y-1.5">
                      <p className="text-[11px] text-muted">{calendarsError.message}</p>
                      <button
                        onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
                        className="w-full px-2 py-1 text-xs text-white bg-accent hover:bg-accent-hover rounded transition"
                      >
                        Reconnect
                      </button>
                    </div>
                  ) : calendarsError ? (
                    <p className="text-[11px] text-red-400 px-1 py-2">{calendarsError.message}</p>
                  ) : (
                    <ul className="max-h-64 overflow-y-auto">
                      {sortedCalendars.map((c) => {
                        const active = isCalendarActive(c.id);
                        return (
                          <li key={c.id}>
                            <button
                              onClick={() => toggleCalendarActive(c.id)}
                              disabled={savingCalendarFilter}
                              className="w-full flex items-center gap-2 px-1.5 py-1 text-xs text-primary rounded hover:bg-surface-secondary transition disabled:opacity-50"
                            >
                              <input
                                type="checkbox"
                                checked={active}
                                readOnly
                                className="w-3.5 h-3.5 rounded accent-purple-500 flex-shrink-0"
                              />
                              <span
                                className="w-2 h-2 rounded-sm flex-shrink-0"
                                style={{ backgroundColor: c.backgroundColor || "#6366f1" }}
                              />
                              <span className="truncate flex-1 text-left">
                                {c.name}
                                {c.primary && <span className="ml-1 text-[9px] text-muted">(primary)</span>}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => setRulesOpen(true)}
            className="px-1.5 py-0.5 text-[10px] text-muted hover:text-primary transition"
            title="Manage availability rules"
          >
            Rules
          </button>
        </div>
      )}
    </div>
  );

  // Mobile three-feature action row — Day/Week toggle, Calendars, Rules.
  // Replaces the desktop legendBar on narrow layouts; legend chips move
  // under the day-chip header (passed to the calendar via legendSlot).
  const mobileActionBar = showControls ? (
    <div className="grid grid-cols-3 items-stretch gap-1.5 px-3 py-1.5 border-b border-secondary text-xs shrink-0">
      {/* a) Day | Work week (Mon–Fri) | Week (Sun–Sat) toggle */}
      <div className="flex items-stretch rounded-md border border-DEFAULT overflow-hidden text-[11px] font-medium">
        <button
          onClick={() => setMobileView("day")}
          className={`flex-1 px-2 py-1.5 transition ${
            mobileView === "day"
              ? "bg-indigo-500 text-white"
              : "text-secondary hover:text-primary"
          }`}
        >
          Day
        </button>
        <button
          onClick={() => setMobileView("workweek")}
          className={`flex-1 px-2 py-1.5 transition border-l border-DEFAULT ${
            mobileView === "workweek"
              ? "bg-indigo-500 text-white"
              : "text-secondary hover:text-primary"
          }`}
        >
          Work week
        </button>
        <button
          onClick={() => setMobileView("week")}
          className={`flex-1 px-2 py-1.5 transition border-l border-DEFAULT ${
            mobileView === "week"
              ? "bg-indigo-500 text-white"
              : "text-secondary hover:text-primary"
          }`}
        >
          Week
        </button>
      </div>

      {/* b) Calendars — popover opens below (portal-ish positioning with top-full) */}
      <div className="relative">
        <button
          onClick={() => setCalPickerOpen((o) => !o)}
          className="w-full h-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md border border-DEFAULT text-[11px] font-medium text-secondary hover:text-primary transition"
        >
          <span>Calendars</span>
          <span className="flex items-center gap-[3px]">
            {sortedCalendars.slice(0, 3).map((c) => (
              <span
                key={c.id}
                className={`w-2 h-2 rounded-sm border ${isCalendarActive(c.id) ? "" : "opacity-25"}`}
                style={{
                  backgroundColor: c.backgroundColor || "#6366f1",
                  borderColor: c.backgroundColor || "#6366f1",
                }}
              />
            ))}
          </span>
          <span className="text-[10px]">▾</span>
        </button>
        {calPickerOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setCalPickerOpen(false)} />
            <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-40 w-64 max-w-[calc(100vw-1rem)] bg-surface-inset border border-DEFAULT rounded-lg shadow-xl p-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted px-1 pb-1.5">
                Calendars
              </p>
              {calendarsLoading ? (
                <p className="text-xs text-muted px-1 py-2">Loading…</p>
              ) : calendarsError?.kind === "reconnect" ? (
                <div className="px-1 py-2 space-y-1.5">
                  <p className="text-[11px] text-muted">{calendarsError.message}</p>
                  <button
                    onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
                    className="w-full px-2 py-1 text-xs text-white bg-accent hover:bg-accent-hover rounded transition"
                  >
                    Reconnect
                  </button>
                </div>
              ) : calendarsError ? (
                <p className="text-[11px] text-red-400 px-1 py-2">{calendarsError.message}</p>
              ) : (
                <ul className="max-h-64 overflow-y-auto">
                  {sortedCalendars.map((c) => {
                    const active = isCalendarActive(c.id);
                    return (
                      <li key={c.id}>
                        <button
                          onClick={() => toggleCalendarActive(c.id)}
                          disabled={savingCalendarFilter}
                          className="w-full flex items-center gap-2 px-1.5 py-1 text-xs text-primary rounded hover:bg-surface-secondary transition disabled:opacity-50"
                        >
                          <input
                            type="checkbox"
                            checked={active}
                            readOnly
                            className="w-3.5 h-3.5 rounded accent-purple-500 flex-shrink-0"
                          />
                          <span
                            className="w-2 h-2 rounded-sm flex-shrink-0"
                            style={{ backgroundColor: c.backgroundColor || "#6366f1" }}
                          />
                          <span className="truncate flex-1 text-left">
                            {c.name}
                            {c.primary && <span className="ml-1 text-[9px] text-muted">(primary)</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {/* c) Rules */}
      <button
        onClick={() => setRulesOpen(true)}
        className="w-full h-full px-2 py-1.5 rounded-md border border-DEFAULT text-[11px] font-medium text-secondary hover:text-primary transition"
      >
        Rules
      </button>
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      className={`flex-1 min-w-0 flex flex-col overflow-hidden ${className}`}
    >
      {weekNav}
      {forceMobile ? mobileActionBar : legendBar}
      <div className="flex-1 min-h-0 overflow-hidden">
        {forceMobile ? (
          mobileView === "week" ? (
            // Full Sun–Sat week. weekStart is the Sunday of the containing
            // week (set via getSunday() at page level). John's rule:
            // calendar views always start Sunday on the left, end Saturday
            // on the right.
            <WeeklyCalendar
              events={events}
              slots={slots}
              locationByDay={locationByDay}
              timezone={timezone}
              weekStart={weekStart}
              daysToShow={7}
              hideToolbar
              headerGutterSlot={tzChip}
              legendSlot={legendChips}
              primaryCalendar={calendars[0]}
              onEventClick={handleEventClick}
            />
          ) : mobileView === "workweek" ? (
            // Work week — Mon through Fri (5 days), anchored to Monday of
            // the selected week.
            <WeeklyCalendar
              events={events}
              slots={slots}
              locationByDay={locationByDay}
              timezone={timezone}
              weekStart={mondayAnchor}
              daysToShow={5}
              hideToolbar
              headerGutterSlot={tzChip}
              legendSlot={legendChips}
              primaryCalendar={calendars[0]}
              onEventClick={handleEventClick}
            />
          ) : (
            <DayView
              events={events}
              slots={slots}
              locationByDay={locationByDay}
              timezone={timezone}
              weekStart={todayAnchor}
              legendSlot={legendChips}
              primaryCalendar={calendars[0]}
              onEventClick={handleEventClick}
            />
          )
        ) : (
          <WeeklyCalendar
            events={events}
            slots={slots}
            locationByDay={locationByDay}
            timezone={timezone}
            weekStart={desktopAnchor}
            daysToShow={desktopDays}
            hideToolbar
            headerGutterSlot={tzChip}
            primaryCalendar={calendars[0]}
            onEventClick={handleEventClick}
          />
        )}
      </div>

      {/* Rules modal — pops over everything. Uses the existing
          AvailabilityRules component for full parity with the
          availability page. */}
      {rulesOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 overflow-y-auto"
          onClick={() => setRulesOpen(false)}
        >
          <div
            className="bg-surface-inset border border-DEFAULT rounded-2xl w-full max-w-2xl mx-4 my-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-secondary">
              <h3 className="text-sm font-semibold text-primary">Availability rules</h3>
              <button
                onClick={() => setRulesOpen(false)}
                className="text-muted hover:text-primary text-lg leading-none transition"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="max-h-[75vh] overflow-y-auto">
              <AvailabilityRules onSaved={fetchSchedule} />
            </div>
          </div>
        </div>
      )}

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
