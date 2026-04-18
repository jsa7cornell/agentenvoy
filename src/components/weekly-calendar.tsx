"use client";

import { useEffect, useMemo, useState } from "react";
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
  /** Google's master eventId when this event is an instance of a recurring
   *  series. Used by the override modal to offer a "this one" vs. "all
   *  instances" scope choice. */
  recurringEventId?: string;
  isTransparent?: boolean;
  eventType?: string;
  /** Host-set protection override score (0=Open, 3=Protected, 5=Blocked). Undefined = Auto. */
  protectionOverride?: number;
  /** Scope of the current override, when one is set. "instance" = this event
   *  only; "series" = all instances of the recurring series. */
  protectionOverrideScope?: "instance" | "series";
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
  /** Number of consecutive days to render starting from weekStart.
   *  Defaults to 7 (full week). When < 7, the grid still anchors to
   *  weekStart so the week-nav still aligns; the panel caller can
   *  shift weekStart to today to get a "today + N-1" view. */
  daysToShow?: number;
  /** Hide the built-in top toolbar (score legend + TZ chip).
   *  When true, callers like AvailabilityPanel render their own
   *  chrome and the calendar grid starts clean. */
  hideToolbar?: boolean;
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
  daysToShow = 7,
  hideToolbar = false,
}: WeeklyCalendarProps) {
  const dayCount = Math.max(1, Math.min(7, daysToShow));
  // Build array of day strings
  const days = useMemo(() => {
    const result: string[] = [];
    const start = new Date(weekStart + "T12:00:00");
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      result.push(d.toISOString().slice(0, 10));
    }
    return result;
  }, [weekStart, dayCount]);

  // Live "now" tick — drives the today-bubble, past-day shading, and the
  // red current-time indicator line. Updates every 60s so the line moves
  // and today flips at midnight without a page reload.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Today's YYYY-MM-DD in the calendar's display timezone — so "today"
  // matches what the grid actually labels, not the viewer's server tz.
  const todayStr = useMemo(() => toDayStr(now.toISOString(), timezone), [now, timezone]);

  // Current-time offset in minutes-since-midnight (display timezone).
  // Used to position the red line within today's column.
  const nowMinutesInDay = useMemo(
    () => toMinutesInDay(now.toISOString(), timezone),
    [now, timezone]
  );
  const todayIndex = days.indexOf(todayStr); // -1 if this week doesn't include today

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

  // Dynamic min-width: ~100px per day column + 56px gutter (so 3-day mode
  // doesn't force horizontal scroll on narrow panels).
  const gridMinWidth = 56 + dayCount * 100;
  const gridCols = `56px repeat(${dayCount}, minmax(0, 1fr))`;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Score legend + timezone badge — hidden when the parent renders its own. */}
      {!hideToolbar && (
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
      )}

      {/* Scrollable calendar area */}
      <div className="flex-1 overflow-auto">
        <div style={{ minWidth: gridMinWidth }}>
          {/* Header row: day labels + locations.
              For the current day, render the date number in a filled
              circle — same visual pattern Google Calendar uses so it's
              unambiguous which column the red time line belongs to. */}
          <div className="grid sticky top-0 z-20 bg-surface border-b border-secondary"
            style={{ gridTemplateColumns: gridCols }}>
            <div className="p-2" /> {/* gutter */}
            {days.map((day) => {
              const loc = locationByDay[day];
              const isToday = day === todayStr;
              const isPast = day < todayStr;
              const d = new Date(day + "T12:00:00");
              const weekdayLabel = d.toLocaleDateString("en-US", { weekday: "short" });
              const dayNum = d.getDate();
              return (
                <div
                  key={day}
                  className={`px-1 py-2 text-center border-l border-secondary ${isPast ? "opacity-60" : ""}`}
                >
                  <div className={`text-[10px] uppercase tracking-wider ${isToday ? "text-indigo-400 font-semibold" : "text-muted"}`}>
                    {weekdayLabel}
                  </div>
                  <div className="mt-0.5 flex justify-center">
                    {isToday ? (
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-indigo-500 text-white text-sm font-semibold">
                        {dayNum}
                      </span>
                    ) : (
                      <span className={`text-sm font-medium ${isPast ? "text-muted" : "text-primary"}`}>
                        {dayNum}
                      </span>
                    )}
                  </div>
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
              style={{ gridTemplateColumns: gridCols }}>
              <div className="px-1 py-1.5 flex items-start justify-end">
                <span className="text-[10px] text-muted">All day</span>
              </div>
              {days.map((day) => {
                const allDayEvents = allDayByDay[day] || [];
                const isPast = day < todayStr;
                return (
                  <div
                    key={day}
                    className={`border-l border-secondary px-1 py-1 flex flex-col gap-0.5 min-h-[28px] ${isPast ? "opacity-60" : ""}`}
                  >
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
            style={{ gridTemplateColumns: gridCols }}>
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
            {days.map((day) => {
              const isToday = day === todayStr;
              const isPast = day < todayStr;
              // Red current-time line — only on today's column, and only when
              // the current minute falls inside the visible grid range.
              const nowTop = ((nowMinutesInDay - gridStartMin) / 30) * ROW_HEIGHT;
              const showNowLine =
                isToday &&
                nowMinutesInDay >= gridStartMin &&
                nowMinutesInDay <= HOUR_END * 60;
              return (
              <div
                key={day}
                className={`relative border-l border-secondary ${isPast ? "opacity-60" : ""}`}
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

                  // Hover tooltip text — summary, time range, calendar, location
                  const timeLabel = `${formatTimeLabel(ev.start, timezone)} – ${formatTimeLabel(ev.end, timezone)}`;
                  const tooltipParts = [ev.summary, timeLabel];
                  if (ev.location) tooltipParts.push(ev.location);
                  if (ev.calendar && ev.calendar !== primaryCalendar) tooltipParts.push(ev.calendar);
                  const tooltip = tooltipParts.join(" · ");

                  return (
                    <div
                      key={ev.id}
                      onClick={() => onEventClick?.(ev)}
                      title={tooltip}
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

                {/* Red "now" line — Google Calendar–style horizontal marker
                    at the current minute inside today's column. The knob on
                    the left edge helps eye-track which column it belongs to
                    even when the viewer scrolls. Lives ABOVE opacity so the
                    past-day fade on other columns never applies here. */}
                {showNowLine && (
                  <div
                    className="absolute inset-x-0 z-20 pointer-events-none"
                    style={{ top: nowTop - 1 }}
                  >
                    <div className="relative">
                      <div className="h-[2px] bg-red-500" />
                      <div className="absolute -left-1 -top-1 w-2.5 h-2.5 rounded-full bg-red-500 ring-2 ring-surface" />
                    </div>
                  </div>
                )}
              </div>
              );
            })}
            {/* Horizontal "now" rule spanning the full grid width — faint,
                runs across past days too so the viewer can see "everything
                above here already happened." Uses a lower z-index than
                the solid today line so they stack cleanly. */}
            {todayIndex !== -1 && nowMinutesInDay >= gridStartMin && nowMinutesInDay <= HOUR_END * 60 && (
              <div
                className="absolute left-0 right-0 z-10 pointer-events-none"
                style={{ top: ((nowMinutesInDay - gridStartMin) / 30) * ROW_HEIGHT }}
              >
                <div className="h-px bg-red-500/20" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
