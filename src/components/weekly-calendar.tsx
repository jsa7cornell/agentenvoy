"use client";

import { useMemo } from "react";
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
  formatTimeLabel,
  layoutEvents,
} from "@/lib/calendar-utils";
import { shortTimezoneLabel } from "@/lib/timezone";

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
  /** Host-set protection override score (0=Open, 3=Protected, 5=Blocked). Undefined = Auto. */
  protectionOverride?: number;
}

export interface TunerSlot {
  start: string;
  end: string;
  score: number;
  confidence: string;
  reason: string;
  eventSummary?: string;
  /** Factual category (open, event, blocked_window, off_hours, weekend, blackout).
   *  Used for heatmap color coding. */
  kind?: string;
  /** Intrinsic protection category: "none" | "preference" | "commitment".
   *  Surfaces in the slot tooltip so the host can see why a slot is protected. */
  blockCost?: string;
  /** Protection firmness: "weak" | "strong". Paired with blockCost in the tooltip. */
  firmness?: string;
}

/**
 * Human-readable tier label derived from score + VIP reachability. Used in
 * the slot tooltip so the host can see at a glance which tier a slot lives
 * in ("first offer", "stretch", "deep stretch", "never") without having to
 * memorize the numeric score table.
 */
export function slotTierLabel(score: number): string {
  if (score < 0) return "host preferred";
  if (score <= 1) return "bookable";
  if (score <= 3) return "protected (VIP)";
  return "blocked";
}

/**
 * Build a descriptive tooltip string for a slot. Shows tier, score, reason,
 * and (when set) the intrinsic block-cost/firmness label — so a host
 * hovering Tuesday 7 AM sees "stretch (VIP) — off hours · preference:strong".
 * This is the single source of tooltip truth; WeeklyCalendar and DayView
 * both call it.
 */
export function slotTooltip(slot: TunerSlot): string {
  const parts: string[] = [
    `${slotTierLabel(slot.score)} (score ${slot.score})`,
    slot.reason,
  ];
  if (slot.blockCost && slot.blockCost !== "none") {
    const firm = slot.firmness ? `:${slot.firmness}` : "";
    parts.push(`${slot.blockCost}${firm}`);
  }
  if (slot.eventSummary) {
    parts.push(slot.eventSummary);
  }
  return parts.join(" · ");
}

interface WeeklyCalendarProps {
  events: TunerEvent[];
  slots: TunerSlot[];
  locationByDay: Record<string, string | null>;
  timezone: string;
  weekStart: string;
  primaryCalendar?: string;
  onSlotClick?: (label: string) => void;
  onEventClick?: (event: TunerEvent) => void;
}

export function WeeklyCalendar({
  events,
  slots,
  locationByDay,
  timezone,
  weekStart,
  primaryCalendar,
  onSlotClick,
  onEventClick,
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

  // Group timed events by day (exclude workingLocation/outOfOffice event types and all-day)
  const eventsByDay = useMemo(() => {
    const grouped: Record<string, TunerEvent[]> = {};
    for (const day of days) grouped[day] = [];
    for (const e of events) {
      if (e.eventType === "workingLocation" || e.eventType === "outOfOffice") continue;
      if (e.isAllDay) continue;
      const dayStr = toDayStr(e.start, timezone);
      if (grouped[dayStr]) grouped[dayStr].push(e);
    }
    return grouped;
  }, [events, days, timezone]);

  // Group all-day events by day (can span multiple days).
  // All-day events are stored with UTC midnight dates (e.g. "2026-04-15T00:00:00Z").
  // We compare DATE STRINGS, not Date objects, to avoid timezone bleed where
  // midnight UTC falls on the previous local day (e.g. EDT = UTC-4).
  const allDayByDay = useMemo(() => {
    const grouped: Record<string, TunerEvent[]> = {};
    for (const day of days) grouped[day] = [];
    for (const e of events) {
      if (!e.isAllDay) continue;
      if (e.eventType === "workingLocation" || e.eventType === "outOfOffice") continue;
      // Extract date portion from stored UTC ISO strings
      const evStartDate = e.start.substring(0, 10);  // "2026-04-15"
      const evEndDate = e.end.substring(0, 10);        // "2026-04-16" (exclusive)
      for (const day of days) {
        // day is already "YYYY-MM-DD" — compare strings directly
        if (day >= evStartDate && day < evEndDate) {
          grouped[day].push(e);
        }
      }
    }
    return grouped;
  }, [events, days]);

  const hasAnyAllDay = useMemo(
    () => days.some((day) => (allDayByDay[day] || []).length > 0),
    [days, allDayByDay]
  );

  // Layout events per day with column positions
  const layoutByDay = useMemo(() => {
    const result: Record<string, ReturnType<typeof layoutEvents<TunerEvent>>> = {};
    for (const day of days) {
      result[day] = layoutEvents<TunerEvent>(eventsByDay[day] || [], timezone);
    }
    return result;
  }, [eventsByDay, days, timezone]);

  const gridStartMin = HOUR_START * 60;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Score legend + timezone badge */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-secondary text-[11px] text-muted shrink-0">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-100 dark:bg-emerald-600/60 border border-emerald-500 dark:border-emerald-400" /> Available</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-teal-100 dark:bg-teal-600/70 border border-teal-500 dark:border-teal-400" /> Office Hours</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-100 dark:bg-amber-600/50 border border-amber-500 dark:border-amber-400" /> Protected</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-100 dark:bg-red-600/50 border border-red-600 dark:border-red-500" /> Blocked</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-50 dark:bg-indigo-900/80 border border-indigo-500 dark:border-indigo-400" /> Calendar event</span>
        <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-secondary/60 border border-DEFAULT/60 text-primary font-medium" title={timezone}>
          {shortTimezoneLabel(timezone)}
        </span>
      </div>

      {/* Scrollable calendar area */}
      <div className="flex-1 overflow-auto">
        <div className="min-w-[700px]">
          {/* Header row: day labels + locations */}
          <div className="grid sticky top-0 z-20 bg-surface border-b border-secondary"
            style={{ gridTemplateColumns: "56px repeat(7, minmax(0, 1fr))" }}>
            <div className="p-2" /> {/* gutter */}
            {days.map((day) => {
              const loc = locationByDay[day];
              return (
                <div key={day} className="px-1 py-2 text-center border-l border-secondary">
                  <div className="text-xs font-medium text-primary">{formatDayHeader(day)}</div>
                  {loc && (
                    <div className="mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] bg-surface-secondary text-secondary border border-DEFAULT">
                      {loc}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* All-day events row */}
          {hasAnyAllDay && (
            <div className="grid border-b border-secondary"
              style={{ gridTemplateColumns: "56px repeat(7, minmax(0, 1fr))" }}>
              <div className="px-1 py-1.5 flex items-start justify-end">
                <span className="text-[10px] text-muted">All day</span>
              </div>
              {days.map((day) => {
                const allDayEvents = allDayByDay[day] || [];
                return (
                  <div key={day} className="border-l border-secondary px-1 py-1 flex flex-col gap-0.5 min-h-[28px]">
                    {allDayEvents.map((e) => (
                      <div
                        key={e.id}
                        className={`text-[10px] leading-tight px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/80 border-l-2 border-l-indigo-500 text-primary truncate ${onEventClick ? "cursor-pointer hover:brightness-110 transition-[filter]" : ""}`}
                        title={e.summary}
                        onClick={() => onEventClick?.(e)}
                      >
                        {e.summary}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {/* Time grid */}
          <div className="grid relative"
            style={{ gridTemplateColumns: "56px repeat(7, minmax(0, 1fr))" }}>
            {/* Hour labels gutter */}
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

            {/* Day columns */}
            {days.map((day) => (
              <div
                key={day}
                className="relative border-l border-secondary"
                style={{ height: TOTAL_ROWS * ROW_HEIGHT }}
              >
                {/* Slot backgrounds */}
                {Array.from({ length: TOTAL_ROWS }, (_, row) => {
                  const mins = gridStartMin + row * 30;
                  const slot = slotIndex[`${day}-${mins}`];
                  const scoreColor = slot ? getScoreColor(slot.score, slot.kind) : "bg-surface-secondary/30";
                  const scoreBorder = slot ? getScoreBorder(slot.score, slot.kind) : "";
                  const isHourBoundary = row % 2 === 0;

                  return (
                    <div
                      key={row}
                      className={`absolute inset-x-0 ${scoreColor} ${isHourBoundary ? "border-t border-DEFAULT/60" : ""} cursor-pointer hover:brightness-125 transition-all group`}
                      style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                      title={slot ? slotTooltip(slot) : "No data"}
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
                      {/* Tooltip on hover — surfaces tier + block intrinsics */}
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
                      onClick={() => onEventClick?.(ev)}
                      className={`absolute rounded-sm border-l-2 ${getEventAccent(ev.responseStatus, ev.isTransparent)} ${getEventBg(ev.responseStatus, ev.isTransparent)} overflow-hidden z-10 ${onEventClick ? "cursor-pointer hover:brightness-110 transition-[filter]" : "pointer-events-none"}`}
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
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
