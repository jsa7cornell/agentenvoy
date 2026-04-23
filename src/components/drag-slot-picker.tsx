"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";

interface Slot {
  start: string;
  end: string;
  isShortSlot?: boolean;
}

interface DragSlotPickerProps {
  slotsForDay: Slot[];
  durationMinutes: number;
  timezone: string;
  onSelectSlot?: (msg: string, slot: { start: string; end: string }) => void;
  dateStr: string;
  workingHourStart?: number; // default 8
  workingHourEnd?: number;   // default 18
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toLocalMins(isoStr: string, tz: string): number {
  const date = new Date(isoStr);
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "numeric", hour12: false, timeZone: tz,
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  return (h === 24 ? 0 : h) * 60 + m;
}

function fmtTimeFromMins(mins: number, dateStr: string, tz: string): string {
  // Build an ISO from the dateStr at the given local minutes in tz.
  // Easiest: compute offset by formatting a known UTC date in tz.
  const baseUtc = new Date(dateStr + "T12:00:00Z");
  const baseLocalMins = toLocalMins(baseUtc.toISOString(), tz);
  const deltaMins = mins - baseLocalMins;
  const target = new Date(baseUtc.getTime() + deltaMins * 60_000);
  return target.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: tz,
  });
}

function isoFromMins(mins: number, dateStr: string, tz: string): string {
  const baseUtc = new Date(dateStr + "T12:00:00Z");
  const baseLocalMins = toLocalMins(baseUtc.toISOString(), tz);
  const deltaMins = mins - baseLocalMins;
  return new Date(baseUtc.getTime() + deltaMins * 60_000).toISOString();
}

function fmtMsg(startMins: number, endMins: number, dateStr: string, tz: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  return `${day} · ${fmtTimeFromMins(startMins, dateStr, tz)} – ${fmtTimeFromMins(endMins, dateStr, tz)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DragSlotPicker({
  slotsForDay,
  durationMinutes,
  timezone,
  onSelectSlot,
  dateStr,
  workingHourStart = 8,
  workingHourEnd = 18,
}: DragSlotPickerProps) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const [confirmed, setConfirmed] = useState(false);

  const SPAN = (workingHourEnd - workingHourStart) * 60;

  // Stable key derived from slot start times — prevents new array refs from
  // retriggering effects every parent render (which reset the drag position).
  const slotsKey = slotsForDay
    .filter(s => !s.isShortSlot)
    .map(s => s.start)
    .join("|");

  const slotMins = useMemo(
    () =>
      slotsForDay
        .filter(s => !s.isShortSlot)
        .map(s => toLocalMins(s.start, timezone))
        .sort((a, b) => a - b),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slotsKey, timezone],
  );

  // 15-min snap candidates: every valid slot start, plus +15 between consecutive
  // 30-min slots (since the meeting fits in either half, it fits anywhere between).
  const candidates = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < slotMins.length; i++) {
      out.push(slotMins[i]);
      if (i + 1 < slotMins.length && slotMins[i + 1] - slotMins[i] === 30) {
        out.push(slotMins[i] + 15);
      }
    }
    return out;
  }, [slotMins]);

  // Pick the middle candidate as the default so the pill starts centered
  // rather than jammed to the earliest slot.
  const defaultMins = candidates[Math.floor(candidates.length / 2)] ?? 0;

  const [currentMins, setCurrentMins] = useState<number>(defaultMins);

  // Reset only when the day changes — NOT on every render (which would undo
  // every drag). dateStr is the source of truth for "new day, reset pill".
  useEffect(() => {
    setConfirmed(false);
    setCurrentMins(defaultMins);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateStr]);

  const drag = useRef<{ startX: number; startMins: number; rulerWidth: number } | null>(null);

  // Build available "runs" — contiguous spans of free time within working hours.
  // A run starts at slotMins[i] and extends through consecutive 30-min slots
  // (gap === 30) plus durationMinutes for the final fit.
  const availRuns: Array<{ startMins: number; endMins: number }> = [];
  if (slotMins.length > 0) {
    let runStart = slotMins[0];
    for (let i = 0; i < slotMins.length; i++) {
      const isLast = i === slotMins.length - 1;
      const gapBreaks = !isLast && slotMins[i + 1] - slotMins[i] !== 30;
      if (isLast || gapBreaks) {
        availRuns.push({ startMins: runStart, endMins: slotMins[i] + durationMinutes });
        if (!isLast) runStart = slotMins[i + 1];
      }
    }
  }

  const minsToPct = (m: number) => (m - workingHourStart * 60) / SPAN * 100;

  // Busy = working hours minus the union of available runs.
  const busyBlocks: Array<{ startPct: number; widthPct: number }> = [];
  let cursor = workingHourStart * 60;
  for (const run of availRuns) {
    if (run.startMins > cursor) {
      busyBlocks.push({
        startPct: minsToPct(cursor),
        widthPct: minsToPct(run.startMins) - minsToPct(cursor),
      });
    }
    cursor = Math.max(cursor, run.endMins);
  }
  if (cursor < workingHourEnd * 60) {
    busyBlocks.push({
      startPct: minsToPct(cursor),
      widthPct: minsToPct(workingHourEnd * 60) - minsToPct(cursor),
    });
  }

  const pillLeft = (currentMins - workingHourStart * 60) / SPAN * 100;
  const pillWidth = durationMinutes / SPAN * 100;

  const snapToCandidate = useCallback((rawMins: number) => {
    if (candidates.length === 0) return 0;
    return candidates.reduce((best, m) =>
      Math.abs(m - rawMins) < Math.abs(best - rawMins) ? m : best, candidates[0]);
  }, [candidates]);

  const onDragStart = useCallback((clientX: number) => {
    if (!rulerRef.current || confirmed || candidates.length === 0) return;
    drag.current = {
      startX: clientX,
      startMins: currentMins,
      rulerWidth: rulerRef.current.getBoundingClientRect().width,
    };
  }, [confirmed, currentMins, candidates.length]);

  const onDragMove = useCallback((clientX: number) => {
    if (!drag.current) return;
    const { startX, startMins, rulerWidth } = drag.current;
    const deltaPct = (clientX - startX) / rulerWidth * 100;
    const deltaMins = deltaPct / 100 * SPAN;
    setCurrentMins(snapToCandidate(startMins + deltaMins));
  }, [SPAN, snapToCandidate]);

  const onDragEnd = useCallback(() => {
    drag.current = null;
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => onDragMove(e.clientX);
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) onDragMove(e.touches[0].clientX);
    };
    const onUp = () => onDragEnd();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onUp);
    };
  }, [onDragMove, onDragEnd]);

  if (candidates.length === 0) {
    return <p className="text-xs text-muted py-2">No available times</p>;
  }

  const endMins = currentMins + durationMinutes;
  const displayTime = `${fmtTimeFromMins(currentMins, dateStr, timezone)} – ${fmtTimeFromMins(endMins, dateStr, timezone)}`;

  const hourTicks: number[] = [];
  for (let h = workingHourStart; h <= workingHourEnd; h += 2) hourTicks.push(h);

  return (
    <div className="select-none">
      {/* Ruler */}
      <div className="relative pb-6">
        <div
          ref={rulerRef}
          className="relative h-12 rounded-lg overflow-hidden"
          style={{ background: "rgba(52,199,89,0.10)" }}
        >
          {/* Busy blocks (everything outside available runs) */}
          {busyBlocks.map((b, i) => (
            <div
              key={i}
              className="absolute inset-y-0 pointer-events-none z-[1]"
              style={{
                left: `${b.startPct}%`,
                width: `${b.widthPct}%`,
                background: "repeating-linear-gradient(45deg, var(--surface-secondary), var(--surface-secondary) 5px, var(--surface-tertiary) 5px, var(--surface-tertiary) 10px)",
              }}
            />
          ))}

          {/* Hour tick lines */}
          {hourTicks.map(h => (
            <div
              key={h}
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: `${(h - workingHourStart) / (workingHourEnd - workingHourStart) * 100}%`,
                borderLeft: "1px solid rgba(255,255,255,0.06)",
              }}
            />
          ))}

          {/* Draggable pill */}
          <div
            className={`absolute top-1 bottom-1 rounded-md z-[2] flex items-center justify-center
              ${confirmed
                ? "cursor-default bg-emerald-500"
                : "cursor-grab active:cursor-grabbing bg-blue-500 hover:bg-blue-400"
              }
              transition-colors shadow-md`}
            style={{
              left: `${pillLeft}%`,
              width: `${pillWidth}%`,
            }}
            onMouseDown={e => { e.preventDefault(); onDragStart(e.clientX); }}
            onTouchStart={e => { onDragStart(e.touches[0].clientX); }}
          >
            <div className="flex gap-[3px] pointer-events-none">
              {Array.from({ length: 6 }).map((_, i) => (
                <span
                  key={i}
                  className="w-[3px] h-[3px] rounded-full block bg-white/60"
                />
              ))}
            </div>
          </div>
        </div>

        {/* Hour labels */}
        <div className="absolute left-0 right-0 bottom-0 pointer-events-none h-4">
          {hourTicks.map(h => {
            const pct = (h - workingHourStart) / (workingHourEnd - workingHourStart) * 100;
            const label = h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`;
            return (
              <span
                key={h}
                className="absolute text-[10px] text-muted"
                style={{
                  left: `${pct}%`,
                  transform: "translateX(-50%)",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            );
          })}
        </div>
      </div>

      {/* Time readout + confirm row */}
      <div className="flex items-center justify-between gap-3 mt-2">
        <p className="text-sm font-semibold text-primary">{displayTime}</p>
        {onSelectSlot && (
          <button
            onClick={() => {
              if (confirmed) return;
              setConfirmed(true);
              onSelectSlot(
                fmtMsg(currentMins, endMins, dateStr, timezone),
                {
                  start: isoFromMins(currentMins, dateStr, timezone),
                  end: isoFromMins(endMins, dateStr, timezone),
                },
              );
            }}
            disabled={confirmed}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition disabled:opacity-100
              ${confirmed
                ? "bg-emerald-600"
                : "bg-accent hover:bg-accent-hover"}`}
          >
            {confirmed ? "✓ Confirmed" : "Confirm"}
          </button>
        )}
      </div>
    </div>
  );
}
