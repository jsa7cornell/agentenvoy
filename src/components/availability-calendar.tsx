"use client";

import { useState, useMemo } from "react";

interface Slot {
  start: string;
  end: string;
  score?: number; // 0 = explicitly free (green), 1 = open business hours (yellow)
}

interface AvailabilityCalendarProps {
  slotsByDay: Record<string, Slot[]>;
  timezone: string;
  onSelectSlot?: (formattedTime: string) => void; // Callback when guest clicks a time pill
  currentLocation?: { label: string; until?: string } | null;
  onClearLocation?: () => void; // Optional: show a dismiss button on the location notice
  view?: "month" | "week"; // week = compact single-row strip (ideal for mobile)
}

function getSlotColor(slots: Slot[], isPast: boolean) {
  if (isPast) return "bg-zinc-200 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-700";
  // Only consider visible slots (score ≤ 2) for day color
  const visible = slots.filter((s) => (s.score ?? 0) <= 2);
  if (visible.length === 0) return "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-400 dark:text-zinc-600";
  const best = Math.min(...visible.map((s) => s.score ?? 0));
  if (best <= 0) return "bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-300"; // free time
  return "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-600 dark:text-yellow-300"; // 1-2: potentially doable
}

function getSlotPillColor(score: number | undefined) {
  const s = score ?? 0;
  if (s <= 0) return "border-green-400 dark:border-green-700 text-green-600 dark:text-green-300 hover:border-green-500";
  if (s <= 2) return "border-yellow-400 dark:border-yellow-700 text-yellow-600 dark:text-yellow-300"; // non-clickable
  return ""; // 3+: not rendered
}

function isSlotVisible(score: number | undefined): boolean {
  const s = score ?? 0;
  return s <= 2; // 3+ not shown
}

function isSlotClickable(score: number | undefined): boolean {
  const s = score ?? 0;
  return s <= 0; // only free time (0 and below) is clickable
}

const DAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_LABELS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Get the Sunday-start week containing a given date */
function getWeekStart(d: Date): Date {
  const result = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Format a slot as a human-readable time proposal */
function formatSlotMessage(slot: Slot, dateStr: string, timezone: string) {
  const date = new Date(dateStr + "T12:00:00");
  const dayStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const timeStr = new Date(slot.start).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
    timeZone: timezone,
  })
    .formatToParts(new Date(slot.start))
    .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `How about ${dayStr} at ${timeStr} ${tzAbbr}?`;
}

// ─── Shared sub-components ────────────────────────────────────────────

function SlotPills({
  slots,
  dateStr,
  timezone,
  onSelectSlot,
}: {
  slots: Slot[];
  dateStr: string;
  timezone: string;
  onSelectSlot?: (msg: string) => void;
}) {
  const visible = slots.filter((s) => isSlotVisible(s.score));
  if (visible.length === 0) return <p className="text-xs text-muted">No available slots</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((slot, i) => {
        const clickable = isSlotClickable(slot.score);
        return (
          <button
            key={i}
            onClick={() => clickable && onSelectSlot?.(formatSlotMessage(slot, dateStr, timezone))}
            disabled={!clickable}
            title={!clickable ? "Potentially doable" : undefined}
            className={`px-2 py-1 bg-surface-secondary border rounded-md text-xs transition
              ${getSlotPillColor(slot.score)}
              ${clickable && onSelectSlot ? "hover:bg-surface-tertiary cursor-pointer" : "cursor-default opacity-70"}`}
          >
            {new Date(slot.start).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              timeZone: timezone,
            })}
          </button>
        );
      })}
    </div>
  );
}

function LocationNotice({
  currentLocation,
  onClearLocation,
}: {
  currentLocation: { label: string; until?: string };
  onClearLocation?: () => void;
}) {
  return (
    <div className="mt-3 flex items-start gap-1.5 rounded-md bg-amber-950/40 border border-amber-900/50 px-2 py-1.5">
      <span className="text-amber-400 text-[11px] mt-px">📍</span>
      <p className="text-[10px] text-amber-300 leading-tight flex-1">
        Currently in {currentLocation.label}
        {currentLocation.until ? ` until ${currentLocation.until}` : ""}.
        In-person meetings not available.
      </p>
      {onClearLocation && (
        <button
          onClick={onClearLocation}
          className="text-amber-600 hover:text-amber-400 text-[11px] leading-none mt-px ml-1 transition"
          title="Clear location"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─── Week View ────────────────────────────────────────────────────────

function WeekView({
  slotsByDay,
  timezone,
  onSelectSlot,
  currentLocation,
  onClearLocation,
}: Omit<AvailabilityCalendarProps, "view">) {
  const now = new Date();
  const todayStr = toDateStr(now);
  const thisWeekStartTime = getWeekStart(now).getTime();

  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Compute the start of the displayed week
  const weekStartTime = useMemo(() => {
    const d = new Date(thisWeekStartTime);
    d.setDate(d.getDate() + weekOffset * 7);
    return d.getTime();
  }, [thisWeekStartTime, weekOffset]);

  // Build 7 day cells for the week
  const weekDays = useMemo(() => {
    const days: Array<{ dateStr: string; day: number; dayLabel: string; monthLabel: string }> = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartTime);
      d.setDate(d.getDate() + i);
      days.push({
        dateStr: toDateStr(d),
        day: d.getDate(),
        dayLabel: DAY_LABELS_SHORT[d.getDay()],
        monthLabel: d.toLocaleDateString("en-US", { month: "short" }),
      });
    }
    return days;
  }, [weekStartTime]);

  // Find the bounds of available data for prev/next limits
  const sortedDates = useMemo(() => Object.keys(slotsByDay).sort(), [slotsByDay]);
  const minDate = sortedDates[0] || todayStr;
  const maxDate = sortedDates[sortedDates.length - 1] || todayStr;

  const canGoPrev = weekDays[0].dateStr > minDate && weekOffset > 0;
  const canGoNext = weekDays[6].dateStr < maxDate;

  // Week label: "Apr 12 – 18, 2026"
  const weekLabel = (() => {
    const first = weekDays[0];
    const last = weekDays[6];
    const firstDate = new Date(first.dateStr + "T12:00:00");
    const lastDate = new Date(last.dateStr + "T12:00:00");
    const sameMonth = firstDate.getMonth() === lastDate.getMonth();
    if (sameMonth) {
      return `${first.monthLabel} ${first.day} – ${last.day}, ${firstDate.getFullYear()}`;
    }
    return `${first.monthLabel} ${first.day} – ${last.monthLabel} ${last.day}`;
  })();

  const selectedSlots = selectedDay ? slotsByDay[selectedDay] || [] : [];

  return (
    <div>
      {/* Week navigation header */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => { setWeekOffset((o) => o - 1); setSelectedDay(null); }}
          className={`p-1 rounded hover:bg-surface-secondary transition ${!canGoPrev ? "opacity-30 cursor-default" : ""}`}
          disabled={!canGoPrev}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs font-medium text-primary">{weekLabel}</span>
        <button
          onClick={() => { setWeekOffset((o) => o + 1); setSelectedDay(null); }}
          className={`p-1 rounded hover:bg-surface-secondary transition ${!canGoNext ? "opacity-30 cursor-default" : ""}`}
          disabled={!canGoNext}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Week strip — 7 day cells in a single row */}
      <div className="grid grid-cols-7 gap-1">
        {weekDays.map((wd) => {
          const daySlots = slotsByDay[wd.dateStr] || [];
          const visibleSlots = daySlots.filter((s) => (s.score ?? 0) <= 2);
          const isPast = wd.dateStr < todayStr;
          const isToday = wd.dateStr === todayStr;
          const isSelected = wd.dateStr === selectedDay;
          const colorClass = getSlotColor(daySlots, isPast);
          const hasSlots = !isPast && visibleSlots.length > 0;

          return (
            <button
              key={wd.dateStr}
              onClick={() => hasSlots && setSelectedDay(isSelected ? null : wd.dateStr)}
              disabled={!hasSlots}
              className={`
                flex flex-col items-center rounded-lg py-1.5 px-0.5 transition-all
                ${colorClass}
                ${isToday ? "ring-1 ring-indigo-500" : ""}
                ${isSelected ? "ring-2 ring-foreground" : ""}
                ${hasSlots ? "hover:ring-1 hover:ring-secondary cursor-pointer" : "cursor-default"}
              `}
            >
              <span className="text-[9px] font-medium uppercase leading-none">{wd.dayLabel}</span>
              <span className="text-sm font-semibold leading-tight">{wd.day}</span>
              {hasSlots && (
                <span className="text-[8px] leading-none mt-0.5 opacity-70">
                  {visibleSlots.length} slot{visibleSlots.length !== 1 ? "s" : ""}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected day time slots */}
      {selectedDay && (
        <div className="mt-2.5 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted">
            {new Date(selectedDay + "T12:00:00").toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </div>
          <SlotPills
            slots={selectedSlots}
            dateStr={selectedDay}
            timezone={timezone}
            onSelectSlot={onSelectSlot}
          />
        </div>
      )}

      {/* Location notice */}
      {currentLocation && (
        <LocationNotice currentLocation={currentLocation} onClearLocation={onClearLocation} />
      )}

      {/* Disclaimer */}
      <p className="mt-2 text-[10px] text-muted leading-tight">
        Times are approximate. Envoy may have additional preferences.
      </p>
    </div>
  );
}

// ─── Month View (original) ────────────────────────────────────────────

function MonthView({
  slotsByDay,
  timezone,
  onSelectSlot,
  currentLocation,
  onClearLocation,
}: Omit<AvailabilityCalendarProps, "view">) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay();

  const now = new Date();
  const todayStr = toDateStr(now);

  const cells: Array<{ day: number; dateStr: string } | null> = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, dateStr });
  }

  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const canGoPrev = viewMonth > currentMonthStart;
  const canGoNext = viewMonth < nextMonthStart;

  const selectedSlots = selectedDay ? slotsByDay[selectedDay] || [] : [];

  return (
    <div>
      {/* Month header */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setViewMonth(new Date(year, month - 1, 1))}
          className={`p-1 rounded hover:bg-surface-secondary transition ${!canGoPrev ? "opacity-30 cursor-default" : ""}`}
          disabled={!canGoPrev}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs font-medium text-primary">
          {viewMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </span>
        <button
          onClick={() => setViewMonth(new Date(year, month + 1, 1))}
          className={`p-1 rounded hover:bg-surface-secondary transition ${!canGoNext ? "opacity-30 cursor-default" : ""}`}
          disabled={!canGoNext}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_HEADERS.map((d) => (
          <div key={d} className="text-[10px] text-muted text-center font-medium">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} />;
          const daySlots = slotsByDay[cell.dateStr] || [];
          const visibleSlots = daySlots.filter((s) => (s.score ?? 0) <= 2);
          const isPast = cell.dateStr < todayStr;
          const isToday = cell.dateStr === todayStr;
          const isSelected = cell.dateStr === selectedDay;
          const colorClass = getSlotColor(daySlots, isPast);

          return (
            <button
              key={cell.dateStr}
              onClick={() => !isPast && visibleSlots.length > 0 && setSelectedDay(isSelected ? null : cell.dateStr)}
              disabled={isPast || visibleSlots.length === 0}
              className={`
                aspect-square rounded-md text-xs font-medium flex items-center justify-center transition-all
                ${colorClass}
                ${isToday ? "ring-1 ring-indigo-500" : ""}
                ${isSelected ? "ring-2 ring-foreground" : ""}
                ${!isPast && visibleSlots.length > 0 ? "hover:ring-1 hover:ring-secondary cursor-pointer" : "cursor-default"}
              `}
            >
              {cell.day}
            </button>
          );
        })}
      </div>

      {/* Selected day time slots */}
      {selectedDay && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted">
            {new Date(selectedDay + "T12:00:00").toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </div>
          <SlotPills
            slots={selectedSlots}
            dateStr={selectedDay}
            timezone={timezone}
            onSelectSlot={onSelectSlot}
          />
        </div>
      )}

      {/* Location notice */}
      {currentLocation && (
        <LocationNotice currentLocation={currentLocation} onClearLocation={onClearLocation} />
      )}

      {/* Disclaimer */}
      <p className="mt-3 text-[10px] text-muted leading-tight">
        Times are approximate. Envoy may have additional preferences.
      </p>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────

export function AvailabilityCalendar(props: AvailabilityCalendarProps) {
  const { view = "month", ...rest } = props;
  if (view === "week") return <WeekView {...rest} />;
  return <MonthView {...rest} />;
}
