"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { AttendeeStatusIcon } from "@/components/attendee-status-icon";

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
  /** Google Calendar deep-link — used by the event-click popup to offer a
   *  "View in Google Calendar" jump. */
  htmlLink?: string;
  /** Rolled-up RSVP state of non-host attendees; drives the small person
   *  icon on the tile. See lib/attendee-rollup.ts. */
  attendeeRollup?: "accepted" | "declined" | "pending" | null;
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
/** Plain-language title for a slot's availability state. */
export function slotTierLabel(score: number): string {
  if (score < 0) return "Your preferred time";
  if (score <= 1) return "Available";
  if (score <= 3) return "Held back";
  return "Not available";
}

/**
 * Human-readable explanation of why a slot is in its current state, and
 * (where applicable) what to do to change it. Used in both the hover tooltip
 * and the click popover. No internal jargon (no scores, no "VIP", no
 * "preference:weak").
 */
export function slotExplanation(slot: TunerSlot): { body: string; cta: "rules" | "calendar" | "link" | null } {
  const { reason, score, eventSummary } = slot;

  // ── Open / preferred ──────────────────────────────────────────────────
  if (score < 0) return { body: "Envoy offers these times first.", cta: null };
  if (score <= 1) {
    if (reason === "declined invite") return { body: "You declined this event — Envoy treats it as free.", cta: null };
    if (reason?.startsWith("FYI:")) return { body: "Informational event — Envoy treats this as free.", cta: null };
    if (reason === "low priority (flexible)") return { body: "Flexible event — Envoy can schedule over this.", cta: null };
    return { body: "Open for scheduling.", cta: null };
  }

  // ── Protected (score 2–3) — shown but not offered to guests ──────────
  if (score <= 3) {
    if (reason === "just outside business hours")
      return { body: "Just past when this link's hours end — not offered to guests.", cta: "link" };
    if (reason === "off hours")
      return { body: "Outside this link's available hours — not offered to guests.", cta: "link" };
    if (reason === "weekend daytime")
      return { body: "Weekend — not offered by this link. Edit link preferences to open weekends.", cta: "link" };
    if (reason === "soft hold")
      return { body: `Hold block${eventSummary ? ` (${eventSummary})` : ""} — Envoy protects calendar holds. Delete the event to make this available.`, cta: "calendar" };
    if (reason === "tentative meeting")
      return { body: `Tentative: ${eventSummary || "unconfirmed meeting"}. Envoy holds this back until confirmed or declined.`, cta: "calendar" };
    if (reason === "recurring 1:1")
      return { body: `Recurring 1:1${eventSummary ? ` (${eventSummary})` : ""}. Treated as a soft commitment — decline or delete to free it up.`, cta: "calendar" };
    if (reason?.startsWith("buffer:"))
      return { body: "Meeting buffer — Envoy keeps this free between back-to-backs. Tell Envoy to adjust your buffer rules.", cta: "rules" };
    if (reason === "protected (host set)")
      return { body: "You set this time as protected.", cta: "rules" };
    return { body: "Held back — not offered to guests.", cta: "rules" };
  }

  // ── Blocked (score ≥ 4) — never offered ──────────────────────────────
  if (reason === "flight")
    return { body: `Travel${eventSummary ? `: ${eventSummary}` : ""} — Envoy never books over this.`, cta: null };
  if (reason === "immovable")
    return { body: `${eventSummary || "Fixed event"} — marked immovable, never offered.`, cta: null };
  if (reason === "confirmed meeting" || reason === "confirmed group meeting")
    return { body: `Confirmed: ${eventSummary || "meeting"}`, cta: "calendar" };
  if (reason === "tentative group meeting")
    return { body: `Group meeting (tentative): ${eventSummary || "meeting"} — Envoy blocks this to avoid double-booking.`, cta: "calendar" };
  if (reason === "high priority")
    return { body: `${eventSummary || "High-priority event"} — Envoy never books over this.`, cta: "calendar" };
  if (reason === "out of office")
    return { body: "Out of office — not available.", cta: "calendar" };
  if (reason === "sleep hours")
    return { body: "Sleep hours — Envoy never books this.", cta: null };
  if (reason === "early morning / late evening")
    return { body: "Very early or very late — not offered to guests.", cta: "link" };
  if (reason === "weekend edge" || reason === "weekend off-hours (sleep)")
    return { body: "Weekend hours — not offered by this link.", cta: "link" };
  if (reason?.startsWith("all-day event:"))
    return { body: `All-day event — Envoy blocks this time.`, cta: "calendar" };
  if (reason?.startsWith("blackout day:"))
    return { body: "Day off — this whole day is blocked.", cta: "rules" };
  if (reason === "blocked (host set)")
    return { body: "You set this time as unavailable.", cta: "rules" };

  return { body: eventSummary ? `Busy: ${eventSummary}` : "Not available.", cta: eventSummary ? "calendar" : null };
}

/** @deprecated Use slotExplanation() for UI copy; kept for any legacy callers. */
export function slotTooltip(slot: TunerSlot): string {
  const { body } = slotExplanation(slot);
  return `${slotTierLabel(slot.score)} — ${body}`;
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
  /**
   * Click-to-protect: when set, clicking an open slot opens a small
   * chooser anchored at the slot with Protect / Block buttons. The
   * handler persists a one-time block rule scoped to the clicked 30m.
   * Resolve only after the new schedule is committed; the popover stays
   * open with a saving state until then.
   */
  onCreateSlotProtection?: (params: {
    start: string;
    end: string;
    level: "protect" | "block";
  }) => Promise<void> | void;
  /**
   * Click-to-remove-rule: when set, the block-reason popover shown on
   * scored slots gains a "Remove this rule" button. Fires only for slots
   * whose protection comes from a user-created block rule (slot.kind ===
   * "blocked_window" with an eventSummary label). The handler looks up
   * the rule by originalText and removes it from structuredRules.
   */
  onRemoveSlotRule?: (params: {
    ruleLabel: string;
  }) => Promise<void> | void;
  /** Number of consecutive days to render starting from weekStart.
   *  Defaults to 7 (full week). When < 7, the grid still anchors to
   *  weekStart so the week-nav still aligns; the panel caller can
   *  shift weekStart to today to get a "today + N-1" view. */
  daysToShow?: number;
  /** Hide the built-in top toolbar (score legend + TZ chip).
   *  When true, callers like AvailabilityPanel render their own
   *  chrome and the calendar grid starts clean. */
  hideToolbar?: boolean;
  /** Optional content to render in the gutter cell of the day-header row
   *  (above the time labels, left of the day columns). Used by
   *  AvailabilityPanel to put the TZ picker on the "times" side. */
  headerGutterSlot?: React.ReactNode;
  /** Optional strip rendered directly below the sticky day-chip row
   *  (above the all-day row and time grid). Used to place the score
   *  legend under the day chips on mobile. */
  legendSlot?: React.ReactNode;
  /** Name of the currently selected bookable link. Shown in slot popup
   *  attribution when the block source is link preferences. */
  selectedLinkName?: string;
}

export function WeeklyCalendar({
  events,
  slots,
  locationByDay: _locationByDay, // eslint-disable-line @typescript-eslint/no-unused-vars
  timezone,
  weekStart,
  primaryCalendar,
  onSlotClick,
  onEventClick,
  onCreateSlotProtection,
  onRemoveSlotRule,
  daysToShow = 7,
  hideToolbar = false,
  headerGutterSlot,
  legendSlot,
  selectedLinkName,
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

  // Block-reason popover state — which slot's info indicator the viewer
  // tapped. Null when closed. One open at a time across all days.
  // x/y are viewport-relative coords of the ⓘ button used to position
  // the popover via `position: fixed` (escapes overflow clipping).
  const [openBlockInfo, setOpenBlockInfo] = useState<{
    day: string;
    row: number;
    x: number;
    y: number;
  } | null>(null);

  // Protect/Block chooser state — opened by clicking an open (score 0)
  // slot when onCreateSlotProtection is provided. Same coords convention
  // as openBlockInfo so the popover positioning helper can flip near edges.
  // startRow/endRow track the spanned range (single 30m when click, N×30m
  // when drag); used to derive the rule's timeStart/timeEnd and to compute
  // overlapping events for the in-chooser warning.
  const [openProtectChooser, setOpenProtectChooser] = useState<{
    day: string;
    startRow: number;
    endRow: number;
    x: number;
    y: number;
    slotStart: string;
    slotEnd: string;
  } | null>(null);
  const [protectSaving, setProtectSaving] = useState(false);
  // Tracks the in-flight "Remove this rule" call so the button reflects
  // a saving state and is disabled until the schedule round-trip lands.
  const [removingRule, setRemovingRule] = useState(false);

  // Drag-select state. Set on pointerdown on an open (score 0) slot when
  // onCreateSlotProtection is wired. `originRow` is the cell where the
  // gesture started; `currentRow` tracks where the pointer is now (clamped
  // to the day column's grid bounds). Pointer capture stays on the origin
  // cell so fast drags don't lose the gesture across cells. Same-day only —
  // cross-column drift is clamped to `day` via the day-column bounding rect.
  const [dragState, setDragState] = useState<{
    day: string;
    originRow: number;
    currentRow: number;
    startClientY: number;
  } | null>(null);
  // Synchronous read for gating hover tooltip + onClick during a drag.
  // useState bumps render-after; useRef gives the same-tick signal handlers need.
  const draggingRef = useRef(false);
  // Set true at the end of pointerup so the synthesized `click` that the
  // browser fires immediately after gets swallowed (without this, a
  // zero-movement pointerup → click would open the chooser twice).
  const pointerHandledRef = useRef(false);
  // Per-day column DOM refs for pointer-to-row hit-testing during drag.
  const dayColumnRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Hover tooltip state — tracks the slot being hovered + viewport position
  // so we can render via a portal at `position: fixed`, escaping the
  // overflow:hidden/auto ancestors that clipped the old absolute tooltip.
  const [hoverTooltip, setHoverTooltip] = useState<{
    slot: TunerSlot;
    x: number;
    y: number;
  } | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close the popover when the user clicks anywhere else on the page, taps
  // Escape, or scrolls the grid. Critical on mobile where there's no hover
  // and the popover otherwise stays stuck until you tap the exact icon.
  useEffect(() => {
    if (!openBlockInfo) return;
    const close = () => setOpenBlockInfo(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [openBlockInfo]);

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
            <div className="p-2 flex items-end justify-end">{headerGutterSlot}</div>
            {days.map((day) => {
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
                </div>
              );
            })}
          </div>

          {legendSlot}

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
                  className="absolute left-0 right-0 flex justify-center text-[11px] text-secondary leading-none"
                  style={{ top: i * 2 * ROW_HEIGHT, transform: "translateY(-50%)" }}
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
                ref={(el) => {
                  if (el) dayColumnRefs.current.set(day, el);
                  else dayColumnRefs.current.delete(day);
                }}
                className={`relative border-l border-secondary ${isPast ? "opacity-60" : ""}`}
                style={{
                  height: TOTAL_ROWS * ROW_HEIGHT,
                  // Disable native text selection / scroll-vs-drag wobble for
                  // the active drag column. Cheap to apply globally to all
                  // columns; the gesture itself is gated by dragState.day.
                  userSelect: dragState ? "none" : undefined,
                  touchAction: dragState ? "none" : undefined,
                }}
              >
                {/* Slot backgrounds */}
                {Array.from({ length: TOTAL_ROWS }, (_, row) => {
                  const mins = gridStartMin + row * 30;
                  const slot = slotIndex[`${day}-${mins}`];
                  const scoreColor = slot ? getScoreColor(slot.score, slot.kind) : "bg-surface-secondary/30";
                  const scoreBorder = slot ? getScoreBorder(slot.score, slot.kind) : "";
                  const isHourBoundary = row % 2 === 0;

                  // "Block top" detection: show the small "?" indicator on
                  // slots that start a new non-bookable run (score >= 2 and
                  // not a calendar event — events have their own click UX).
                  // We only show one indicator per contiguous run so the
                  // grid doesn't get busy.
                  const prevMins = gridStartMin + (row - 1) * 30;
                  const prevSlot = row > 0 ? slotIndex[`${day}-${prevMins}`] : undefined;
                  const isRunStart =
                    !!slot &&
                    slot.score >= 2 &&
                    slot.kind !== "event" &&
                    (!prevSlot ||
                      prevSlot.score < 2 ||
                      prevSlot.kind === "event" ||
                      (prevSlot.reason !== slot.reason));
                  const infoOpen =
                    openBlockInfo?.day === day && openBlockInfo?.row === row;

                  // Drag-select gating: only OPEN slots are valid drag starts.
                  // Drag THROUGH protected/blocked slots is fine (the chooser
                  // commit is independent of in-range slot scoring), but
                  // starting on a scored slot defers to its existing UX
                  // (the "?" icon popover handles it).
                  const canStartDrag =
                    !!slot &&
                    slot.score === 0 &&
                    !!onCreateSlotProtection;
                  const isDragOrigin =
                    dragState?.day === day && dragState?.originRow === row;

                  return (
                    <div
                      key={row}
                      className={`absolute inset-x-0 ${scoreColor} ${isHourBoundary ? "border-t border-DEFAULT/60" : ""} cursor-pointer hover:brightness-125 transition-all`}
                      style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                      onMouseEnter={(e) => {
                        if (!slot) return;
                        // Suppress hover tooltip while a drag is in flight —
                        // otherwise it flickers per cell the pointer crosses.
                        if (draggingRef.current) return;
                        if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
                        const r = e.currentTarget.getBoundingClientRect();
                        setHoverTooltip({ slot, x: r.left + r.width / 2, y: r.top });
                      }}
                      onMouseLeave={() => {
                        hoverTimeout.current = setTimeout(() => setHoverTooltip(null), 80);
                      }}
                      onPointerDown={(e) => {
                        if (!canStartDrag || !slot) return;
                        if (e.button !== undefined && e.button !== 0) return;
                        // Capture the pointer to this cell so subsequent
                        // pointermove / pointerup fire here regardless of
                        // where the pointer drifts. Without this, fast drags
                        // lose the gesture as the pointer crosses cells.
                        try {
                          e.currentTarget.setPointerCapture(e.pointerId);
                        } catch {
                          // Older browsers / non-pointer-aware environments
                          // — fall back to per-cell events. Drag still works
                          // best-effort but may drop fast gestures.
                        }
                        setHoverTooltip(null);
                        setDragState({
                          day,
                          originRow: row,
                          currentRow: row,
                          startClientY: e.clientY,
                        });
                        draggingRef.current = true;
                      }}
                      onPointerMove={(e) => {
                        if (!isDragOrigin) return;
                        // Hit-test by Y against the start day's column so the
                        // gesture stays locked to that column even if the
                        // pointer drifts horizontally into a neighbor.
                        const col = dayColumnRefs.current.get(day);
                        if (!col) return;
                        const colRect = col.getBoundingClientRect();
                        const offsetY = e.clientY - colRect.top;
                        const rawRow = Math.floor(offsetY / ROW_HEIGHT);
                        const newRow = Math.max(
                          0,
                          Math.min(TOTAL_ROWS - 1, rawRow),
                        );
                        setDragState((s) =>
                          s && s.currentRow !== newRow
                            ? { ...s, currentRow: newRow }
                            : s,
                        );
                      }}
                      onPointerUp={(e) => {
                        if (!isDragOrigin || !dragState) return;
                        try {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        } catch {
                          /* ignore */
                        }
                        const startRow = Math.min(
                          dragState.originRow,
                          dragState.currentRow,
                        );
                        const endRow = Math.max(
                          dragState.originRow,
                          dragState.currentRow,
                        );
                        const startMins = gridStartMin + startRow * 30;
                        const endMins = gridStartMin + endRow * 30;
                        const startSlot = slotIndex[`${day}-${startMins}`];
                        const endSlot = slotIndex[`${day}-${endMins}`];
                        setDragState(null);
                        draggingRef.current = false;
                        pointerHandledRef.current = true;
                        if (!startSlot || !endSlot) return;
                        // Anchor the chooser at the bottom-right of the
                        // FINAL row of the selection, not the origin row,
                        // so it never covers the dragged range.
                        const col = dayColumnRefs.current.get(day);
                        const colRect = col?.getBoundingClientRect();
                        const anchorY = colRect
                          ? colRect.top + (endRow + 1) * ROW_HEIGHT
                          : e.currentTarget.getBoundingClientRect().bottom;
                        const anchorX = colRect
                          ? colRect.right
                          : e.currentTarget.getBoundingClientRect().right;
                        setOpenProtectChooser({
                          day,
                          startRow,
                          endRow,
                          x: anchorX,
                          y: anchorY,
                          slotStart: startSlot.start,
                          slotEnd: endSlot.end,
                        });
                      }}
                      onClick={(e) => {
                        // The browser fires `click` after `pointerup` on the
                        // same target — if pointerup already opened the
                        // chooser, swallow this synthesized click. Cleared
                        // on the next frame so a subsequent (non-pointer)
                        // click still works for fallback paths.
                        if (pointerHandledRef.current) {
                          pointerHandledRef.current = false;
                          return;
                        }
                        setHoverTooltip(null);
                        if (!slot) return;
                        // Fallback path for environments where pointer events
                        // didn't fire (older browsers, jsdom tests that only
                        // dispatch click). Same single-slot semantics.
                        if (slot.score === 0 && onCreateSlotProtection) {
                          const r = e.currentTarget.getBoundingClientRect();
                          setOpenProtectChooser({
                            day,
                            startRow: row,
                            endRow: row,
                            x: r.right,
                            y: r.bottom,
                            slotStart: slot.start,
                            slotEnd: slot.end,
                          });
                          return;
                        }
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
                      {/* Block-reason indicator — tiny info icon on the top
                          of each contiguous blocked/protected run. Click to
                          reveal the reason + a link to the rules panel.
                          Popover is rendered via portal at fixed coords so
                          it escapes overflow:hidden/auto clipping. */}
                      {isRunStart && (
                        <button
                          type="button"
                          aria-label="Why is this blocked?"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setHoverTooltip(null);
                            if (infoOpen) {
                              setOpenBlockInfo(null);
                            } else {
                              const r = e.currentTarget.getBoundingClientRect();
                              setOpenBlockInfo({ day, row, x: r.right, y: r.bottom });
                            }
                          }}
                          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-surface hover:bg-surface text-secondary hover:text-primary flex items-center justify-center border border-DEFAULT shadow-sm z-[5]"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            width="10"
                            height="10"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
                            <circle cx="8" cy="4.5" r="1" />
                            <rect x="7.15" y="6.5" width="1.7" height="5.5" rx="0.6" />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })}

                {/* Drag-select overlay — rendered only on the day column
                    where the gesture started. Shows the spanned range as
                    a translucent amber rectangle so the user has live
                    feedback as they drag. Sits below event tiles (z-10)
                    so existing meetings remain visible through it. */}
                {dragState && dragState.day === day && (() => {
                  const startRow = Math.min(
                    dragState.originRow,
                    dragState.currentRow,
                  );
                  const endRow = Math.max(
                    dragState.originRow,
                    dragState.currentRow,
                  );
                  const top = startRow * ROW_HEIGHT;
                  const height = (endRow - startRow + 1) * ROW_HEIGHT;
                  return (
                    <div
                      className="absolute inset-x-0 z-[8] pointer-events-none bg-amber-400/25 border-2 border-amber-500/70 rounded-sm"
                      style={{ top, height }}
                    />
                  );
                })()}

                {/* Event blocks */}
                {(layoutByDay[day] || []).map((ev) => {
                  const startMin = Math.max(ev.startMin ?? toMinutesInDay(ev.start, timezone), gridStartMin);
                  const endMin = Math.min(ev.endMin ?? toMinutesInDay(ev.end, timezone), HOUR_END * 60);
                  if (endMin <= startMin) return null;

                  const top = ((startMin - gridStartMin) / 30) * ROW_HEIGHT;
                  // -2px so back-to-back events show a visible separator
                  // instead of merging into one block.
                  const height = Math.max(((endMin - startMin) / 30) * ROW_HEIGHT - 2, ROW_HEIGHT * 0.8);
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
                        <div className="flex items-start gap-1">
                          <div className="text-[10px] font-medium text-primary truncate leading-tight flex-1 min-w-0">
                            {ev.summary}
                          </div>
                          {ev.attendeeRollup && (
                            <AttendeeStatusIcon
                              rollup={ev.attendeeRollup}
                              size={10}
                              className="flex-shrink-0 mt-[1px]"
                            />
                          )}
                        </div>
                        {primaryCalendar && ev.calendar && ev.calendar !== primaryCalendar && (
                          <div className="text-[9px] text-muted truncate italic">{ev.calendar}</div>
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

      {/* ── Portal tooltips — rendered at document.body so they escape
           overflow:hidden / overflow:auto ancestors that clip absolute
           children. Both use position:fixed anchored to viewport coords
           captured at mouse/click time. ── */}

      {/* Hover tooltip */}
      {hoverTooltip && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-[9999] px-2.5 py-1.5 rounded-md bg-surface border border-DEFAULT text-[11px] text-primary shadow-2xl pointer-events-none"
          style={{
            left: hoverTooltip.x,
            top: hoverTooltip.y - 6,
            transform: "translate(-50%, -100%)",
            maxWidth: "280px",
          }}
        >
          <div className="font-semibold">{slotTierLabel(hoverTooltip.slot.score)}</div>
          <div className="text-secondary leading-snug">{slotExplanation(hoverTooltip.slot).body}</div>
        </div>,
        document.body,
      )}

      {/* Click popover (block-reason detail) */}
      {openBlockInfo && (() => {
        const s = slotIndex[`${openBlockInfo.day}-${HOUR_START * 60 + openBlockInfo.row * 30}`];
        if (!s) return null;
        // Flip left if popover would overflow right edge of viewport
        const popW = 224; // w-56
        const flipLeft = openBlockInfo.x + popW > window.innerWidth - 8;
        // Flip up if popover would overflow bottom edge
        const popH = 110; // approx
        const flipUp = openBlockInfo.y + popH > window.innerHeight - 8;
        return typeof document !== "undefined" && createPortal(
          <div
            className="fixed z-[9999] w-56 rounded-md bg-surface border-2 border-DEFAULT shadow-2xl p-2.5 text-[11px] text-primary"
            style={{
              left: flipLeft ? openBlockInfo.x - popW : openBlockInfo.x,
              top: flipUp ? openBlockInfo.y - popH - 4 : openBlockInfo.y + 4,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {(() => {
              const { body, cta } = slotExplanation(s);
              // For calendar CTAs, look up the blocking event's GCal deep-link
              // by matching eventSummary against the events list.
              const blockingEvent = cta === "calendar" && s.eventSummary
                ? events.find((e) => e.summary === s.eventSummary && !e.isAllDay)
                : null;
              const gcalLink = blockingEvent?.htmlLink ?? "https://calendar.google.com";
              const linkLabel = selectedLinkName ?? "Primary link";
              // A user-created block rule landed this slot here when the
              // scoring kind is "blocked_window" AND there's a label
              // (originalText) on the slot. Surfacing the "Remove this rule"
              // button only in that case avoids offering a no-op for
              // off-hours / weekend / blackout slots which don't map to a
              // single removable rule.
              const isUserBlock =
                s.kind === "blocked_window" && !!s.eventSummary;
              const removableLabel = isUserBlock ? s.eventSummary! : null;
              return (
                <>
                  <div className="font-semibold mb-1 text-primary">
                    {slotTierLabel(s.score)}
                  </div>
                  <div className="text-secondary leading-relaxed mb-2">{body}</div>
                  {removableLabel && onRemoveSlotRule && (
                    <div className="mb-2 pb-2 border-b border-DEFAULT/40">
                      <div className="text-[10px] text-muted mb-1 italic">
                        Rule: &ldquo;{removableLabel}&rdquo;
                      </div>
                      <button
                        type="button"
                        disabled={removingRule}
                        onClick={async () => {
                          if (removingRule) return;
                          setRemovingRule(true);
                          try {
                            await onRemoveSlotRule({ ruleLabel: removableLabel });
                            setOpenBlockInfo(null);
                          } catch (err) {
                            console.error("[remove-rule] failed:", err);
                          } finally {
                            setRemovingRule(false);
                          }
                        }}
                        className="text-[10px] font-medium text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 transition disabled:opacity-50"
                      >
                        {removingRule ? "Removing…" : "Remove this rule"}
                      </button>
                    </div>
                  )}
                  {cta === "rules" && (
                    <a
                      href="/dashboard/availability"
                      className="block text-indigo-500 dark:text-indigo-400 hover:text-indigo-400 dark:hover:text-indigo-300 transition text-[10px] font-medium"
                    >
                      Adjust your rules &rarr;
                    </a>
                  )}
                  {cta === "link" && (
                    <a
                      href="/dashboard/event-links"
                      className="block text-indigo-500 dark:text-indigo-400 hover:text-indigo-400 dark:hover:text-indigo-300 transition text-[10px] font-medium"
                    >
                      Edit {linkLabel} preferences &rarr;
                    </a>
                  )}
                  {cta === "calendar" && (
                    <a
                      href={gcalLink}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-indigo-500 dark:text-indigo-400 hover:text-indigo-400 dark:hover:text-indigo-300 transition text-[10px] font-medium"
                    >
                      Open in Google Calendar &rarr;
                    </a>
                  )}
                </>
              );
            })()}
          </div>,
          document.body,
        );
      })()}

      {/* Click-to-protect chooser — open slots only. Mirrors the
           block-info popover above: same portal, same flip-on-overflow
           positioning, same border treatment. Two buttons + dismiss; a
           click on the body backdrop closes it without committing. */}
      {openProtectChooser && (() => {
        if (typeof document === "undefined") return null;
        const popW = 240;
        const popH = 170;
        const flipLeft = openProtectChooser.x + popW > window.innerWidth - 8;
        const flipUp = openProtectChooser.y + popH > window.innerHeight - 8;
        const dayLabel = formatDayHeader(openProtectChooser.day);
        const startTimeLabel = formatTimeLabel(openProtectChooser.slotStart, timezone);
        const endTimeLabel = formatTimeLabel(openProtectChooser.slotEnd, timezone);
        const totalMinutes =
          (openProtectChooser.endRow - openProtectChooser.startRow + 1) * 30;
        const isSpan = totalMinutes > 30;
        const rangeLabel = isSpan
          ? `${dayLabel} · ${startTimeLabel}–${endTimeLabel}`
          : `${dayLabel} at ${startTimeLabel}`;
        const promptLine = isSpan
          ? `How should this ${
              totalMinutes >= 60
                ? `${Math.floor(totalMinutes / 60)}h${
                    totalMinutes % 60 ? ` ${totalMinutes % 60}m` : ""
                  }`
                : `${totalMinutes} minutes`
            } be held?`
          : "How should this 30 minutes be held?";
        // Events overlapping the chosen range, scoped to the same day. The
        // chooser surfaces these as a soft warning — protections sit OVER
        // existing meetings without cancelling them.
        const rangeStart = new Date(openProtectChooser.slotStart).getTime();
        const rangeEnd = new Date(openProtectChooser.slotEnd).getTime();
        const overlappingEvents = events.filter((ev) => {
          if (ev.isAllDay) return false;
          const evStart = new Date(ev.start).getTime();
          const evEnd = new Date(ev.end).getTime();
          return evStart < rangeEnd && evEnd > rangeStart;
        });
        const close = () => {
          if (!protectSaving) setOpenProtectChooser(null);
        };
        const commit = async (level: "protect" | "block") => {
          if (!onCreateSlotProtection || protectSaving) return;
          setProtectSaving(true);
          try {
            await onCreateSlotProtection({
              start: openProtectChooser.slotStart,
              end: openProtectChooser.slotEnd,
              level,
            });
            setOpenProtectChooser(null);
          } catch (err) {
            console.error("[protect-chooser] save failed:", err);
          } finally {
            setProtectSaving(false);
          }
        };
        return createPortal(
          <>
            <div
              className="fixed inset-0 z-[9998]"
              onClick={close}
              onPointerDown={close}
            />
            <div
              className="fixed z-[9999] w-60 rounded-md bg-surface border-2 border-DEFAULT shadow-2xl p-2.5 text-[11px] text-primary"
              style={{
                left: flipLeft ? openProtectChooser.x - popW : openProtectChooser.x,
                top: flipUp ? openProtectChooser.y - popH - 4 : openProtectChooser.y + 4,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="font-semibold mb-1 text-primary">{rangeLabel}</div>
              <div className="text-secondary leading-relaxed mb-2.5">
                {protectSaving ? "Saving…" : promptLine}
              </div>
              {overlappingEvents.length > 0 && !protectSaving && (
                <div className="text-[10px] text-muted leading-relaxed mb-2 px-1.5 py-1 rounded bg-surface-secondary/60 border border-DEFAULT/40">
                  Note: this won&apos;t cancel the {overlappingEvents.length}{" "}
                  existing meeting{overlappingEvents.length === 1 ? "" : "s"} in
                  this range.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={protectSaving}
                  onClick={() => commit("protect")}
                  className="px-2 py-2 rounded-lg text-[11px] border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-amber-300 dark:hover:border-amber-800 hover:text-amber-600 dark:hover:text-amber-300 transition disabled:opacity-50"
                >
                  Protect
                </button>
                <button
                  type="button"
                  disabled={protectSaving}
                  onClick={() => commit("block")}
                  className="px-2 py-2 rounded-lg text-[11px] border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-red-300 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-300 transition disabled:opacity-50"
                >
                  Block
                </button>
              </div>
              <button
                type="button"
                disabled={protectSaving}
                onClick={close}
                className="mt-2 w-full text-[10px] text-muted hover:text-secondary transition disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </>,
          document.body,
        );
      })()}
    </div>
  );
}
