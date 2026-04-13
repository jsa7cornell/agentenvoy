"use client";

import { useMemo } from "react";

interface Slot {
  start: string;
  end: string;
  score: number;
}

interface InlineCalendarProps {
  slots: Slot[];
}

/** Simplified weekly calendar showing scored slots inline in the onboarding chat */
export function InlineCalendar({ slots }: InlineCalendarProps) {
  const { days, hours } = useMemo(() => {
    if (slots.length === 0) return { days: [], hours: [] };

    // Group slots by day, only show first 5 weekdays
    const byDay = new Map<string, Slot[]>();
    for (const slot of slots) {
      const d = new Date(slot.start);
      const dayOfWeek = d.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) continue; // skip weekends
      const key = d.toISOString().split("T")[0];
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(slot);
    }

    const sortedDays = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 5);

    // Show 8am-6pm range
    return {
      days: sortedDays,
      hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    };
  }, [slots]);

  if (days.length === 0) {
    return (
      <div className="bg-surface-inset/50 border border-secondary rounded-xl p-4 text-center text-xs text-muted">
        No calendar data available yet
      </div>
    );
  }

  function scoreColor(score: number): string {
    if (score <= 0) return "bg-emerald-500/30 dark:bg-emerald-500/20";
    if (score === 1) return "bg-emerald-400/20 dark:bg-emerald-400/15";
    if (score === 2) return "bg-amber-400/30 dark:bg-amber-400/20";
    if (score === 3) return "bg-orange-400/30 dark:bg-orange-400/20";
    return "bg-red-400/30 dark:bg-red-400/20";
  }

  return (
    <div className="bg-surface-inset/50 border border-secondary rounded-xl p-3 overflow-x-auto">
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `40px repeat(${days.length}, 1fr)`, minWidth: 320 }}>
        {/* Header row — day names */}
        <div /> {/* empty corner */}
        {days.map(([dateStr]) => {
          const d = new Date(dateStr + "T12:00:00");
          return (
            <div key={dateStr} className="text-center text-[10px] font-medium text-muted pb-1">
              {d.toLocaleDateString("en-US", { weekday: "short" })}
              <div className="text-[9px] text-muted/60">
                {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </div>
            </div>
          );
        })}

        {/* Time rows */}
        {hours.map((hour) => (
          <>
            <div key={`label-${hour}`} className="text-[9px] text-muted/60 pr-1 text-right leading-[18px]">
              {hour > 12 ? `${hour - 12}p` : hour === 12 ? "12p" : `${hour}a`}
            </div>
            {days.map(([dateStr, daySlots]) => {
              // Find the slot for this hour (top of hour)
              const slot = daySlots.find((s) => {
                const h = new Date(s.start).getHours();
                return h === hour;
              });
              const score = slot?.score ?? 1;
              return (
                <div
                  key={`${dateStr}-${hour}`}
                  className={`h-[18px] rounded-sm ${scoreColor(score)} transition-colors`}
                  title={slot ? `Score ${score}: ${slot.start}` : `${hour}:00`}
                />
              );
            })}
          </>
        ))}
      </div>

      {/* Legend */}
      <div className="flex gap-3 mt-2 pt-2 border-t border-secondary justify-center">
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded-sm bg-emerald-400/20" />
          <span className="text-[9px] text-muted">Open</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded-sm bg-amber-400/20" />
          <span className="text-[9px] text-muted">Soft hold</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2.5 h-2.5 rounded-sm bg-red-400/20" />
          <span className="text-[9px] text-muted">Protected</span>
        </div>
      </div>
    </div>
  );
}
