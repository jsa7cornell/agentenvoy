"use client";

import { useMemo } from "react";

export interface TunerEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  calendar: string;
  location?: string;
  attendeeCount?: number;
  responseStatus?: string;
  isAllDay: boolean;
  isRecurring: boolean;
  isTransparent?: boolean;
  eventType?: string;
}

export interface TunerSlot {
  start: string;
  end: string;
  score: number;
  confidence: string;
  reason: string;
  eventSummary?: string;
}

interface WeeklyCalendarProps {
  events: TunerEvent[];
  slots: TunerSlot[];
  locationByDay: Record<string, string | null>;
  timezone: string;
  weekStart: string;
  onSlotClick?: (label: string) => void;
}

// Display range: 7 AM to 9 PM (14 hours, 28 half-hour rows)
const HOUR_START = 7;
const HOUR_END = 21;
const TOTAL_ROWS = (HOUR_END - HOUR_START) * 2;
const ROW_HEIGHT = 28; // px per 30-min row

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function getScoreColor(score: number): string {
  if (score <= 0) return "bg-emerald-900/40";
  if (score === 1) return "bg-emerald-900/25";
  if (score === 2) return "bg-amber-900/30";
  if (score === 3) return "bg-orange-900/30";
  if (score === 4) return "bg-red-900/25";
  return "bg-red-950/40";
}

function getScoreBorder(score: number): string {
  if (score <= 0) return "border-emerald-600";
  if (score === 1) return "border-emerald-700";
  if (score === 2) return "border-amber-600";
  if (score === 3) return "border-orange-600";
  if (score === 4) return "border-red-700";
  return "border-red-900";
}

function getEventAccent(responseStatus?: string, isTransparent?: boolean): string {
  if (isTransparent) return "border-l-zinc-600";
  if (responseStatus === "declined") return "border-l-zinc-600";
  if (responseStatus === "tentative") return "border-l-amber-500";
  return "border-l-indigo-500";
}

function getEventBg(responseStatus?: string, isTransparent?: boolean): string {
  if (isTransparent || responseStatus === "declined") return "bg-zinc-800/60";
  if (responseStatus === "tentative") return "bg-amber-950/40";
  return "bg-indigo-950/50";
}

function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

function toMinutesInDay(iso: string, tz: string): number {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    timeZone: tz,
  }).formatToParts(d);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
  return hour * 60 + minute;
}

function toDayStr(iso: string, tz: string): string {
  const d = new Date(iso);
  // Format to YYYY-MM-DD in the target timezone
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function formatDayHeader(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatTimeLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  }).format(new Date(iso));
}

// Group overlapping events and assign column positions
function layoutEvents(
  dayEvents: TunerEvent[],
  tz: string
): Array<TunerEvent & { col: number; totalCols: number; startMin: number; endMin: number }> {
  if (dayEvents.length === 0) return [];

  const withTimes = dayEvents
    .map((e) => ({
      ...e,
      startMin: toMinutesInDay(e.start, tz),
      endMin: toMinutesInDay(e.end, tz),
    }))
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const result: Array<TunerEvent & { col: number; totalCols: number; startMin: number; endMin: number }> = [];
  const columns: number[] = []; // end times per column

  for (const ev of withTimes) {
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      if (ev.startMin >= columns[c]) {
        columns[c] = ev.endMin;
        result.push({ ...ev, col: c, totalCols: 0 });
        placed = true;
        break;
      }
    }
    if (!placed) {
      result.push({ ...ev, col: columns.length, totalCols: 0 });
      columns.push(ev.endMin);
    }
  }

  // Assign totalCols: for each cluster of overlapping events, set the max column count
  // Simple approach: total cols = max(col) + 1 across all events
  const totalCols = columns.length;
  return result.map((e) => ({ ...e, totalCols }));
}

export function WeeklyCalendar({
  events,
  slots,
  locationByDay,
  timezone,
  weekStart,
  onSlotClick,
}: WeeklyCalendarProps) {
  // Build array of 7 day strings
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

  // Index slots by day+time for quick lookup
  const slotIndex = useMemo(() => {
    const idx: Record<string, TunerSlot> = {};
    for (const s of slots) {
      const dayStr = toDayStr(s.start, timezone);
      const mins = toMinutesInDay(s.start, timezone);
      idx[`${dayStr}-${mins}`] = s;
    }
    return idx;
  }, [slots, timezone]);

  // Group events by day (exclude workingLocation/outOfOffice event types and all-day)
  const eventsByDay = useMemo(() => {
    const grouped: Record<string, TunerEvent[]> = {};
    for (const day of days) grouped[day] = [];
    for (const e of events) {
      if (e.eventType === "workingLocation" || e.eventType === "outOfOffice") continue;
      if (e.isAllDay) continue;
      const dayStr = toDayStr(e.start, timezone);
      if (grouped[dayStr]) {
        grouped[dayStr].push(e);
      }
    }
    return grouped;
  }, [events, days, timezone]);

  // Layout events per day with column positions
  const layoutByDay = useMemo(() => {
    const result: Record<string, ReturnType<typeof layoutEvents>> = {};
    for (const day of days) {
      result[day] = layoutEvents(eventsByDay[day] || [], timezone);
    }
    return result;
  }, [eventsByDay, days, timezone]);

  const gridStartMin = HOUR_START * 60;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Score legend */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-zinc-800 text-[11px] text-zinc-500 shrink-0">
        <span className="text-zinc-400 font-medium">Scores:</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-900/60 border border-emerald-700" /> Open</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-900/50 border border-amber-600" /> Soft hold</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-orange-900/50 border border-orange-600" /> Friction</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-900/40 border border-red-700" /> Protected</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-950/60 border border-red-900" /> Immovable</span>
      </div>

      {/* Scrollable calendar area */}
      <div className="flex-1 overflow-auto">
        <div className="min-w-[700px]">
          {/* Header row: day labels + locations */}
          <div className="grid sticky top-0 z-20 bg-[#0a0a0f] border-b border-zinc-800"
            style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}>
            <div className="p-2" /> {/* gutter */}
            {days.map((day) => {
              const loc = locationByDay[day];
              return (
                <div key={day} className="px-1 py-2 text-center border-l border-zinc-800">
                  <div className="text-xs font-medium text-zinc-300">{formatDayHeader(day)}</div>
                  {loc && (
                    <div className="mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-400 border border-zinc-700">
                      {loc}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Time grid */}
          <div className="grid relative"
            style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}>
            {/* Hour labels gutter */}
            <div className="relative" style={{ height: TOTAL_ROWS * ROW_HEIGHT }}>
              {Array.from({ length: HOUR_END - HOUR_START }, (_, i) => (
                <div
                  key={i}
                  className="absolute right-2 text-[10px] text-zinc-600 leading-none"
                  style={{ top: i * 2 * ROW_HEIGHT - 6 }}
                >
                  {formatHour(HOUR_START + i)}
                </div>
              ))}
            </div>

            {/* Day columns */}
            {days.map((day) => (
              <div
                key={day}
                className="relative border-l border-zinc-800"
                style={{ height: TOTAL_ROWS * ROW_HEIGHT }}
              >
                {/* Slot backgrounds */}
                {Array.from({ length: TOTAL_ROWS }, (_, row) => {
                  const mins = gridStartMin + row * 30;
                  const slot = slotIndex[`${day}-${mins}`];
                  const scoreColor = slot ? getScoreColor(slot.score) : "bg-zinc-900/20";
                  const scoreBorder = slot ? getScoreBorder(slot.score) : "";
                  const isHourBoundary = row % 2 === 0;

                  return (
                    <div
                      key={row}
                      className={`absolute inset-x-0 ${scoreColor} ${isHourBoundary ? "border-t border-zinc-800/50" : ""} cursor-pointer hover:brightness-125 transition-all group`}
                      style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                      title={slot ? `Score ${slot.score}: ${slot.reason}${slot.eventSummary ? ` — ${slot.eventSummary}` : ""}` : "No data"}
                      onClick={() => {
                        if (onSlotClick && slot) {
                          const dayLabel = formatDayHeader(day);
                          const timeLabel = formatTimeLabel(slot.start, timezone);
                          onSlotClick(`Tell me about ${dayLabel} at ${timeLabel}`);
                        }
                      }}
                    >
                      {/* Thin left accent line for scored slots */}
                      {slot && slot.score >= 2 && (
                        <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${scoreBorder}`} />
                      )}
                      {/* Tooltip on hover */}
                      {slot && (
                        <div className="hidden group-hover:block absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-30 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-300 whitespace-nowrap shadow-lg pointer-events-none">
                          Score {slot.score}: {slot.reason}
                          {slot.eventSummary && <span className="text-zinc-500"> — {slot.eventSummary}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Event blocks */}
                {(layoutByDay[day] || []).map((ev) => {
                  const startMin = Math.max(ev.startMin ?? toMinutesInDay(ev.start, timezone), gridStartMin);
                  const endMin = Math.min(ev.endMin ?? toMinutesInDay(ev.end, timezone), HOUR_END * 60);
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
                        <div className="text-[10px] font-medium text-zinc-200 truncate leading-tight">
                          {ev.summary}
                        </div>
                        {height > ROW_HEIGHT * 1.5 && ev.location && (
                          <div className="text-[9px] text-zinc-500 truncate">{ev.location}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
