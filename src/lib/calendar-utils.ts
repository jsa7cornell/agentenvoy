// Shared calendar display utilities used by WeeklyCalendar and DayView

export const HOUR_START = 7;
export const HOUR_END = 21;
export const TOTAL_ROWS = (HOUR_END - HOUR_START) * 2;
export const ROW_HEIGHT = 28; // px per 30-min row

// Score bands: Available (0-1), Protected (2-3), Blocked (4-5)
// Office hours get a distinct teal to stand out from regular available (emerald).
export function getScoreColor(score: number, kind?: string): string {
  if (kind === "office_hours") return "bg-teal-100 dark:bg-teal-600/70";
  if (score <= 1) return "bg-emerald-100 dark:bg-emerald-600/60";
  if (score <= 3) return "bg-amber-100 dark:bg-amber-600/50";
  return "bg-red-100 dark:bg-red-600/50";
}

export function getScoreBorder(score: number, kind?: string): string {
  if (kind === "office_hours") return "border-teal-500 dark:border-teal-400";
  if (score <= 1) return "border-emerald-500 dark:border-emerald-400";
  if (score <= 3) return "border-amber-500 dark:border-amber-400";
  return "border-red-600 dark:border-red-500";
}

export function getEventAccent(responseStatus?: string, isTransparent?: boolean): string {
  if (isTransparent) return "border-l-zinc-600";
  if (responseStatus === "declined") return "border-l-zinc-600";
  if (responseStatus === "tentative") return "border-l-amber-500";
  return "border-l-indigo-500";
}

export function getEventBg(responseStatus?: string, isTransparent?: boolean): string {
  if (responseStatus === "declined") return "bg-zinc-200/60 dark:bg-zinc-800/60";
  if (isTransparent) return "bg-zinc-200/80 dark:bg-zinc-700/50";
  if (responseStatus === "tentative") return "bg-amber-50 dark:bg-amber-900/70";
  return "bg-indigo-50 dark:bg-indigo-900/80";
}

export function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

export function toMinutesInDay(iso: string, tz: string): number {
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

export function toDayStr(iso: string, tz: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function formatDayHeader(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function formatTimeLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  }).format(new Date(iso));
}

export interface LayoutEvent {
  col: number;
  totalCols: number;
  startMin: number;
  endMin: number;
}

export function layoutEvents<T extends { start: string; end: string }>(
  dayEvents: T[],
  tz: string
): Array<T & LayoutEvent> {
  if (dayEvents.length === 0) return [];

  const withTimes = dayEvents
    .map((e) => ({
      ...e,
      startMin: toMinutesInDay(e.start, tz),
      endMin: toMinutesInDay(e.end, tz),
    }))
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const result: Array<T & LayoutEvent> = [];
  const columns: number[] = [];

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

  const totalCols = columns.length;
  return result.map((e) => ({ ...e, totalCols }));
}
