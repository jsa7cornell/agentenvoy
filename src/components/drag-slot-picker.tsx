"use client";

import { useRef, useState, useCallback, useEffect } from "react";

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
  // Host working hours — fixed scale across all days
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
  // Intl returns 24 for midnight in hour12:false mode on some platforms
  return (h === 24 ? 0 : h) * 60 + m;
}

function fmtTime(isoStr: string, tz: string): string {
  return new Date(isoStr).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: tz,
  });
}

function fmtMsg(start: string, end: string, dateStr: string, tz: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  return `${day} · ${fmtTime(start, tz)} – ${fmtTime(end, tz)}`;
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
  // Only show slots that fit the full duration (not short slots)
  const validSlots = slotsForDay.filter(s => !s.isShortSlot);

  const rulerRef = useRef<HTMLDivElement>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  // Reset when day changes
  useEffect(() => {
    setCurrentIdx(0);
    setConfirmed(false);
  }, [dateStr]);

  const drag = useRef<{
    startX: number;
    startIdx: number;
    rulerWidth: number;
  } | null>(null);

  const SPAN = (workingHourEnd - workingHourStart) * 60;

  // Compute local-minute positions for each valid slot
  const slotMins = validSlots.map(s => toLocalMins(s.start, timezone));

  // Find "booked" gaps between consecutive available slots (gap > 30 min)
  const bookedBlocks: Array<{ startPct: number; widthPct: number; label?: string }> = [];
  for (let i = 0; i < slotMins.length - 1; i++) {
    const gapStart = slotMins[i] + durationMinutes;
    const gapEnd   = slotMins[i + 1];
    if (gapEnd - gapStart > 30) {
      const left  = (gapStart - workingHourStart * 60) / SPAN * 100;
      const width = (gapEnd - gapStart) / SPAN * 100;
      bookedBlocks.push({ startPct: left, widthPct: width });
    }
  }

  // Available band: first slot start → last slot end
  const availStart = slotMins.length > 0
    ? (slotMins[0] - workingHourStart * 60) / SPAN * 100
    : 0;
  const availEnd = slotMins.length > 0
    ? (slotMins[slotMins.length - 1] + durationMinutes - workingHourStart * 60) / SPAN * 100
    : 0;

  // Pill geometry
  const pillLeft  = slotMins.length > 0
    ? (slotMins[currentIdx] - workingHourStart * 60) / SPAN * 100
    : 0;
  const pillWidth = durationMinutes / SPAN * 100;

  // Snap raw minutes to nearest valid slot index
  const snapToIdx = useCallback((rawMins: number) => {
    if (slotMins.length === 0) return 0;
    return slotMins.reduce((best, m, i) =>
      Math.abs(m - rawMins) < Math.abs(slotMins[best] - rawMins) ? i : best, 0);
  }, [slotMins]);

  // Drag handlers (mouse + touch unified)
  const onDragStart = useCallback((clientX: number) => {
    if (!rulerRef.current || confirmed || validSlots.length === 0) return;
    drag.current = {
      startX: clientX,
      startIdx: currentIdx,
      rulerWidth: rulerRef.current.getBoundingClientRect().width,
    };
  }, [confirmed, currentIdx, validSlots.length]);

  const onDragMove = useCallback((clientX: number) => {
    if (!drag.current || slotMins.length === 0) return;
    const { startX, startIdx, rulerWidth } = drag.current;
    const deltaPct = (clientX - startX) / rulerWidth * 100;
    const deltaMins = deltaPct / 100 * SPAN;
    const rawMins = slotMins[startIdx] + deltaMins;
    const newIdx = snapToIdx(rawMins);
    setCurrentIdx(newIdx);
  }, [slotMins, SPAN, snapToIdx]);

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

  if (validSlots.length === 0) {
    return <p className="text-xs text-muted py-2">No available times</p>;
  }

  const currentSlot = validSlots[currentIdx];
  const displayTime = `${fmtTime(currentSlot.start, timezone)} – ${fmtTime(currentSlot.end, timezone)}`;

  // Hour tick labels — every 2h to avoid crowding
  const hourTicks: number[] = [];
  for (let h = workingHourStart; h <= workingHourEnd; h += 2) {
    hourTicks.push(h);
  }

  return (
    <div className="select-none">
      {/* Ruler */}
      <div className="relative pb-5">
        <div
          ref={rulerRef}
          className="relative h-14 rounded-xl overflow-visible"
          style={{ background: "hsl(var(--surface-secondary))" }}
        >
          {/* Available band */}
          <div
            className="absolute inset-y-0 rounded-xl pointer-events-none"
            style={{
              left: `${availStart}%`,
              width: `${availEnd - availStart}%`,
              background: "rgba(52,199,89,0.12)",
            }}
          />

          {/* Booked blocks */}
          {bookedBlocks.map((b, i) => (
            <div
              key={i}
              className="absolute inset-y-0 pointer-events-none z-[1]"
              style={{
                left: `${b.startPct}%`,
                width: `${b.widthPct}%`,
                background: "repeating-linear-gradient(45deg, rgba(255,255,255,0.04), rgba(255,255,255,0.04) 3px, transparent 3px, transparent 8px)",
                borderLeft: "1px solid rgba(255,255,255,0.07)",
                borderRight: "1px solid rgba(255,255,255,0.07)",
              }}
            />
          ))}

          {/* Draggable pill */}
          <div
            className={`absolute top-1.5 bottom-1.5 rounded-[10px] z-[2] flex items-center justify-center
              ${confirmed
                ? "cursor-default"
                : "cursor-grab active:cursor-grabbing"
              }`}
            style={{
              left: `${pillLeft}%`,
              width: `${pillWidth}%`,
              background: confirmed
                ? "linear-gradient(135deg, #16a34a, #15803d)"
                : "linear-gradient(135deg, #7c3aed, #2563eb, #06b6d4)",
              boxShadow: confirmed
                ? "0 2px 16px rgba(22,163,74,0.4)"
                : "0 2px 16px rgba(99,102,241,0.35)",
              transition: "background 0.2s, box-shadow 0.2s",
            }}
            onMouseDown={e => { e.preventDefault(); onDragStart(e.clientX); }}
            onTouchStart={e => { onDragStart(e.touches[0].clientX); }}
          >
            {/* Grip dots */}
            <div className="flex gap-[3px] pointer-events-none">
              {Array.from({ length: 6 }).map((_, i) => (
                <span
                  key={i}
                  className="w-[3px] h-[3px] rounded-full block"
                  style={{ background: "rgba(255,255,255,0.5)" }}
                />
              ))}
            </div>
          </div>

          {/* Hour tick lines */}
          {hourTicks.map(h => (
            <div
              key={h}
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: `${(h - workingHourStart) / (workingHourEnd - workingHourStart) * 100}%`,
                borderLeft: "1px solid rgba(255,255,255,0.05)",
              }}
            />
          ))}
        </div>

        {/* Hour labels */}
        <div className="absolute left-0 right-0 bottom-0 pointer-events-none">
          {hourTicks.map(h => {
            const pct = (h - workingHourStart) / (workingHourEnd - workingHourStart) * 100;
            const label = h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`;
            return (
              <span
                key={h}
                className="absolute text-[8px] font-medium"
                style={{
                  left: `${pct}%`,
                  transform: "translateX(-50%)",
                  color: "hsl(var(--text-muted))",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            );
          })}
        </div>
      </div>

      {/* Live time readout */}
      <p className="text-center text-[17px] font-extrabold tracking-tight mt-1 mb-4"
         style={{ color: "hsl(var(--text-primary))" }}>
        {displayTime}
      </p>

      {/* Confirm button */}
      {onSelectSlot && (
        <button
          onClick={() => {
            if (confirmed) return;
            setConfirmed(true);
            onSelectSlot(
              fmtMsg(currentSlot.start, currentSlot.end, dateStr, timezone),
              { start: currentSlot.start, end: currentSlot.end },
            );
          }}
          disabled={confirmed}
          className="w-full py-3 rounded-2xl text-sm font-bold text-white transition-opacity disabled:opacity-100"
          style={{
            background: confirmed
              ? "linear-gradient(to right, #16a34a, #15803d)"
              : "linear-gradient(to right, #7c3aed, #2563eb, #06b6d4)",
            boxShadow: confirmed
              ? "0 2px 12px rgba(22,163,74,0.35)"
              : "0 2px 12px rgba(99,102,241,0.35)",
          }}
        >
          {confirmed ? "✓ Confirmed" : "Confirm →"}
        </button>
      )}
    </div>
  );
}
