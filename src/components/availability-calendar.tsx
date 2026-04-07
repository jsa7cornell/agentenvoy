"use client";

import { useState } from "react";

interface Slot {
  start: string;
  end: string;
  score?: number; // 0 = explicitly free (green), 1 = open business hours (yellow)
}

interface AvailabilityCalendarProps {
  slotsByDay: Record<string, Slot[]>;
  timezone: string;
  onSelectSlot?: (formattedTime: string) => void; // Callback when guest clicks a time pill
}

function getSlotColor(slots: Slot[], isPast: boolean) {
  if (isPast) return "bg-zinc-900 text-zinc-700";
  if (slots.length === 0) return "bg-zinc-800/50 text-zinc-600";
  const hasScore0 = slots.some((s) => s.score === 0);
  if (hasScore0) return "bg-green-900/50 text-green-300";
  return "bg-amber-900/50 text-amber-300";
}

const DAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function AvailabilityCalendar({
  slotsByDay,
  timezone,
  onSelectSlot,
}: AvailabilityCalendarProps) {
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
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

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

  // Format a slot as a human-readable time proposal
  const formatSlotMessage = (slot: Slot, dateStr: string) => {
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
  };

  return (
    <div>
      {/* Month header */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setViewMonth(new Date(year, month - 1, 1))}
          className={`p-1 rounded hover:bg-zinc-800 transition ${!canGoPrev ? "opacity-30 cursor-default" : ""}`}
          disabled={!canGoPrev}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs font-medium text-zinc-300">
          {viewMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </span>
        <button
          onClick={() => setViewMonth(new Date(year, month + 1, 1))}
          className={`p-1 rounded hover:bg-zinc-800 transition ${!canGoNext ? "opacity-30 cursor-default" : ""}`}
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
          <div key={d} className="text-[10px] text-zinc-500 text-center font-medium">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} />;
          const daySlots = slotsByDay[cell.dateStr] || [];
          const isPast = cell.dateStr < todayStr;
          const isToday = cell.dateStr === todayStr;
          const isSelected = cell.dateStr === selectedDay;
          const colorClass = getSlotColor(daySlots, isPast);

          return (
            <button
              key={cell.dateStr}
              onClick={() => !isPast && setSelectedDay(isSelected ? null : cell.dateStr)}
              disabled={isPast}
              className={`
                aspect-square rounded-md text-xs font-medium flex items-center justify-center transition-all
                ${colorClass}
                ${isToday ? "ring-1 ring-indigo-500" : ""}
                ${isSelected ? "ring-2 ring-white" : ""}
                ${!isPast && daySlots.length > 0 ? "hover:ring-1 hover:ring-zinc-500 cursor-pointer" : "cursor-default"}
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
          <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            {new Date(selectedDay + "T12:00:00").toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </div>
          {selectedSlots.length === 0 ? (
            <p className="text-xs text-zinc-600">No available slots</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {selectedSlots.map((slot, i) => (
                <button
                  key={i}
                  onClick={() =>
                    onSelectSlot?.(formatSlotMessage(slot, selectedDay))
                  }
                  className={`px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-300 transition
                    ${onSelectSlot ? "hover:bg-zinc-700 hover:border-zinc-500 hover:text-white cursor-pointer" : "cursor-default"}`}
                >
                  {new Date(slot.start).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: timezone,
                  })}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Disclaimer */}
      <p className="mt-3 text-[10px] text-zinc-600 leading-tight">
        Times are approximate. Envoy may have additional preferences.
      </p>
    </div>
  );
}
