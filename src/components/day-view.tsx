"use client";

import { useState, useMemo } from "react";
import { TunerEvent, TunerSlot, slotTooltip, slotTierLabel } from "@/components/weekly-calendar";
import {
  HOUR_START,
  HOUR_END,
  TOTAL_ROWS,
  ROW_HEIGHT,
  getScoreColor,
  getScoreBorder,
  getEventAccent,
  getEventBg,
  formatHour,
  toMinutesInDay,
  toDayStr,
  formatDayHeader,
  layoutEvents,
} from "@/lib/calendar-utils";

interface DayViewProps {
  events: TunerEvent[];
  slots: TunerSlot[];
  locationByDay: Record<string, string | null>;
  timezone: string;
  weekStart: string;
  primaryCalendar?: string;
}

const DAY_LABELS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DayView({
  events,
  slots,
  locationByDay,
  timezone,
  weekStart,
  primaryCalendar,
}: DayViewProps) {
  const todayStr = toDateStr(new Date());
  const [selectedDay, setSelectedDay] = useState<string>(todayStr);

  // Build 7 day strings for the week
  const days = useMemo(() => {
    const result: string[] = [];
    const start = new Date(weekStart + "T12:00:00");
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      result.push(d.toISOString().slice(0, 10));
    }
    return result;
  }, [weekStart]);

  // Index slots by day+time
  const slotIndex = useMemo(() => {
    const idx: Record<string, TunerSlot> = {};
    for (const s of slots) {
      const dayStr = toDayStr(s.start, timezone);
      const mins = toMinutesInDay(s.start, timezone);
      idx[`${dayStr}-${mins}`] = s;
    }
    return idx;
  }, [slots, timezone]);

  // Count visible slots per day (for the week strip badges)
  const slotCountByDay = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of slots) {
      const dayStr = toDayStr(s.start, timezone);
      if (s.score <= 2) {
        counts[dayStr] = (counts[dayStr] || 0) + 1;
      }
    }
    return counts;
  }, [slots, timezone]);

  // Best score per day (for strip cell colors)
  const bestScoreByDay = useMemo(() => {
    const best: Record<string, number> = {};
    for (const s of slots) {
      const dayStr = toDayStr(s.start, timezone);
      if (best[dayStr] === undefined || s.score < best[dayStr]) {
        best[dayStr] = s.score;
      }
    }
    return best;
  }, [slots, timezone]);

  // Filter timed events for selected day
  const dayEvents = useMemo(() => {
    return events.filter((e) => {
      if (e.eventType === "workingLocation" || e.eventType === "outOfOffice") return false;
      if (e.isAllDay) return false;
      return toDayStr(e.start, timezone) === selectedDay;
    });
  }, [events, selectedDay, timezone]);

  // All-day events for selected day (can span multiple days)
  const allDayEvents = useMemo(() => {
    return events.filter((e) => {
      if (!e.isAllDay) return false;
      if (e.eventType === "workingLocation" || e.eventType === "outOfOffice") return false;
      const eStart = new Date(e.start);
      const eEnd = new Date(e.end);
      const dayStart = new Date(selectedDay + "T00:00:00");
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      return eStart < dayEnd && eEnd > dayStart;
    });
  }, [events, selectedDay]);

  const laidOut = useMemo(() => layoutEvents(dayEvents, timezone), [dayEvents, timezone]);

  const gridStartMin = HOUR_START * 60;
  const loc = locationByDay[selectedDay];

  function getDayStripColor(dayStr: string): string {
    if (dayStr < todayStr) return "bg-zinc-200 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-700";
    const best = bestScoreByDay[dayStr];
    if (best === undefined) return "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-400 dark:text-zinc-600";
    if (best <= 0) return "bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-300";
    if (best <= 2) return "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-600 dark:text-yellow-300";
    return "bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-300";
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Week strip — day picker */}
      <div className="px-3 py-2 border-b border-secondary shrink-0">
        <div className="grid grid-cols-7 gap-1">
          {days.map((dayStr) => {
            const d = new Date(dayStr + "T12:00:00");
            const dayNum = d.getDate();
            const dayLabel = DAY_LABELS_SHORT[d.getDay()];
            const isPast = dayStr < todayStr;
            const isToday = dayStr === todayStr;
            const isSelected = dayStr === selectedDay;
            const colorClass = getDayStripColor(dayStr);
            const slotCount = slotCountByDay[dayStr] || 0;
            const hasSlots = !isPast && slotCount > 0;

            return (
              <button
                key={dayStr}
                onClick={() => setSelectedDay(dayStr)}
                className={`
                  flex flex-col items-center rounded-lg py-1.5 px-0.5 transition-all
                  ${colorClass}
                  ${isToday ? "ring-1 ring-indigo-500" : ""}
                  ${isSelected ? "ring-2 ring-foreground" : ""}
                  ${!isPast ? "cursor-pointer" : "cursor-default"}
                `}
              >
                <span className="text-[9px] font-medium uppercase leading-none">{dayLabel}</span>
                <span className="text-sm font-semibold leading-tight">{dayNum}</span>
                {hasSlots && (
                  <span className="text-[8px] leading-none mt-0.5 opacity-70">
                    {slotCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected day header */}
      <div className="px-3 py-1.5 border-b border-secondary shrink-0 flex items-center justify-between">
        <span className="text-xs font-medium text-primary">{formatDayHeader(selectedDay)}</span>
        {loc && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary text-secondary border border-DEFAULT">
            {loc}
          </span>
        )}
      </div>

      {/* All-day events */}
      {allDayEvents.length > 0 && (
        <div className="px-3 py-1.5 border-b border-secondary shrink-0 flex flex-wrap gap-1 items-center">
          <span className="text-[10px] text-muted mr-1">All day</span>
          {allDayEvents.map((e) => (
            <span
              key={e.id}
              className="text-[10px] leading-tight px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/80 border-l-2 border-l-indigo-500 text-primary truncate max-w-[200px]"
              title={e.summary}
            >
              {e.summary}
            </span>
          ))}
        </div>
      )}

      {/* Day timeline */}
      <div className="flex-1 overflow-auto">
        <div className="grid relative" style={{ gridTemplateColumns: "44px 1fr" }}>
          {/* Hour labels */}
          <div className="relative" style={{ height: TOTAL_ROWS * ROW_HEIGHT }}>
            {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
              <div
                key={i}
                className="absolute right-2 text-[10px] text-muted leading-none"
                style={{ top: i * 2 * ROW_HEIGHT - 6 }}
              >
                {formatHour(HOUR_START + i)}
              </div>
            ))}
          </div>

          {/* Single day column */}
          <div
            className="relative border-l border-secondary"
            style={{ height: TOTAL_ROWS * ROW_HEIGHT }}
          >
            {/* Slot backgrounds */}
            {Array.from({ length: TOTAL_ROWS }, (_, row) => {
              const mins = gridStartMin + row * 30;
              const slot = slotIndex[`${selectedDay}-${mins}`];
              const scoreColor = slot ? getScoreColor(slot.score, slot.kind) : "bg-surface-secondary/30";
              const scoreBorder = slot ? getScoreBorder(slot.score, slot.kind) : "";
              const isHourBoundary = row % 2 === 0;

              return (
                <div
                  key={row}
                  className={`absolute inset-x-0 ${scoreColor} ${isHourBoundary ? "border-t border-DEFAULT/60" : ""} group`}
                  style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                  title={slot ? slotTooltip(slot) : undefined}
                >
                  {slot && slot.score >= 2 && (
                    <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${scoreBorder}`} />
                  )}
                  {/* Tooltip — surfaces tier + block intrinsics */}
                  {slot && (
                    <div className="hidden group-hover:block absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-30 px-2 py-1 rounded bg-surface-secondary border border-DEFAULT text-[10px] text-primary whitespace-nowrap shadow-lg pointer-events-none">
                      <div className="font-semibold">{slotTierLabel(slot.score)}</div>
                      <div className="text-muted">
                        score {slot.score} · {slot.reason}
                        {slot.blockCost && slot.blockCost !== "none" && (
                          <> · {slot.blockCost}{slot.firmness ? `:${slot.firmness}` : ""}</>
                        )}
                        {slot.eventSummary && <> · {slot.eventSummary}</>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Event blocks */}
            {laidOut.map((ev) => {
              const startMin = Math.max(ev.startMin, gridStartMin);
              const endMin = Math.min(ev.endMin, HOUR_END * 60);
              if (endMin <= startMin) return null;

              const top = ((startMin - gridStartMin) / 30) * ROW_HEIGHT;
              const height = Math.max(((endMin - startMin) / 30) * ROW_HEIGHT, ROW_HEIGHT * 0.8);
              const width = ev.totalCols > 1 ? `${Math.floor(90 / ev.totalCols)}%` : "90%";
              const left = ev.totalCols > 1 ? `${5 + (ev.col / ev.totalCols) * 90}%` : "5%";

              return (
                <div
                  key={ev.id}
                  className={`absolute rounded-sm border-l-2 ${getEventAccent(ev.responseStatus, ev.isTransparent)} ${getEventBg(ev.responseStatus, ev.isTransparent)} overflow-hidden z-10 pointer-events-none`}
                  style={{ top, height, width, left }}
                >
                  <div className="px-1.5 py-0.5">
                    <div className="text-[10px] font-medium text-primary truncate leading-tight">
                      {ev.summary}
                    </div>
                    {primaryCalendar && ev.calendar && ev.calendar !== primaryCalendar && (
                      <div className="text-[9px] text-muted truncate italic">{ev.calendar}</div>
                    )}
                    {height > ROW_HEIGHT * 1.5 && ev.location && (
                      <div className="text-[9px] text-secondary truncate">{ev.location}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
