/**
 * Window binning — group scored half-hour slots into named human windows.
 *
 * Per proposal 2026-04-22 (calendar-matching-widget-dramatic-redesign),
 * §12.7 + §15.2 F1/F2. Deterministic, no LLM.
 *
 * Inputs: a scored slot list for a single day + meeting duration + viewer tz.
 * Output: 1-3 WindowCard entries per day, each commitable at its default start.
 *
 * Rules (in order):
 *   1. Coalesce consecutive 30-min slots into contiguous bands. A gap > 30 min
 *      = new band (event edges are already reflected as missing slots).
 *   2. Split a band at day-part boundaries (Morning / Midday / Afternoon /
 *      Evening) only when each resulting sub-band is ≥ meeting duration.
 *   3. If a band still spans > MAX_BAND_HOURS with no natural split, halve it.
 *
 * Naming: if ≥ NAMED_DAYPART_THRESHOLD of the band's minutes fall inside a
 * single named day-part, use that name. Else fall back to the time range.
 *
 * F1 pin: binning runs in the viewer's picker-authoritative tz. The caller
 * passes tz; assertBinningTz() verifies the render path uses the same tz.
 */
export const DAY_PARTS = [
  { name: "Morning", startHour: 6, endHour: 12 },
  { name: "Midday", startHour: 12, endHour: 14 },
  { name: "Afternoon", startHour: 14, endHour: 17 },
  { name: "Evening", startHour: 17, endHour: 22 },
] as const;

export const NAMED_DAYPART_THRESHOLD = 0.6; // F2: ≥60% in a part → use its name
export const MAX_BAND_HOURS = 4;
export const SLOT_STEP_MS = 30 * 60 * 1000;

export interface BinningSlot {
  start: string; // ISO
  end: string;   // ISO
  score?: number;
  isStretch?: boolean;
}

export interface WindowCard {
  /** ISO — earliest legal start in this window. */
  start: string;
  /** ISO — latest the meeting can end within the band. */
  end: string;
  /** Human-readable window name (day-part, or time-range fallback). */
  name: string;
  /** ISO default start when the user short-clicks the card. */
  defaultStart: string;
  /** ISO default end = defaultStart + duration. */
  defaultEnd: string;
  /** Count of 30-min start options within the window (for tune affordance). */
  slotCount: number;
  /** True if this band contains the scored top-pick for the day. */
  isPick: boolean;
}

/**
 * F1 — verify binning tz matches render tz. Throws in dev; logs in prod.
 * Diverging tz between bin and render will straddle display midnight silently.
 */
export function assertBinningTz(binTz: string, renderTz: string): void {
  if (binTz === renderTz) return;
  const msg = `[window-binning] tz mismatch: bin=${binTz} render=${renderTz}`;
  if (process.env.NODE_ENV !== "production") throw new Error(msg);
  // eslint-disable-next-line no-console
  console.warn(msg);
}

/** Fractional hour (e.g. 9.5) of ISO instant in tz. */
function fractionalHourInTz(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return (h === 24 ? 0 : h) + m / 60;
}

function fmtTimeRange(startIso: string, endIso: string, tz: string): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });
  return `${fmt(startIso)} – ${fmt(endIso)}`;
}

interface Band {
  startIso: string;
  endIso: string;
  slots: BinningSlot[];
}

/** Step 1: coalesce consecutive slots (gap ≤ 30min) into bands. */
function coalesceBands(slots: BinningSlot[]): Band[] {
  if (slots.length === 0) return [];
  const sorted = [...slots].sort((a, b) => a.start.localeCompare(b.start));
  const bands: Band[] = [];
  let current: BinningSlot[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = current[current.length - 1];
    const gap = new Date(sorted[i].start).getTime() - new Date(prev.start).getTime();
    if (gap <= SLOT_STEP_MS) {
      current.push(sorted[i]);
    } else {
      bands.push(bandFromSlots(current));
      current = [sorted[i]];
    }
  }
  bands.push(bandFromSlots(current));
  return bands;
}

function bandFromSlots(slots: BinningSlot[]): Band {
  return {
    startIso: slots[0].start,
    endIso: slots[slots.length - 1].end,
    slots,
  };
}

/** Step 2 + 3: split by day-parts (if each piece ≥ duration) then halve if >MAX. */
function splitBand(band: Band, durationMs: number, tz: string): Band[] {
  const startMs = new Date(band.startIso).getTime();
  const endMs = new Date(band.endIso).getTime();
  if (endMs - startMs <= MAX_BAND_HOURS * 3600_000 && !crossesDayPartBoundary(band, tz)) {
    return [band];
  }
  // Try day-part split. Find a boundary inside (startMs, endMs) such that both
  // halves are ≥ duration. Prefer the boundary closest to the band midpoint.
  const midpoint = (startMs + endMs) / 2;
  const boundaries = dayPartBoundariesInside(band, tz)
    .filter((b) => b - startMs >= durationMs && endMs - b >= durationMs)
    .sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint));
  if (boundaries.length > 0) {
    const split = boundaries[0];
    const left = sliceBand(band, startMs, split);
    const right = sliceBand(band, split, endMs);
    return [...splitBand(left, durationMs, tz), ...splitBand(right, durationMs, tz)];
  }
  // No viable day-part boundary. If still >MAX and both halves would be ≥ duration,
  // halve at midpoint. Otherwise keep as-is (better one oversized card than
  // producing sub-duration cards).
  if (
    endMs - startMs > MAX_BAND_HOURS * 3600_000 &&
    midpoint - startMs >= durationMs &&
    endMs - midpoint >= durationMs
  ) {
    const left = sliceBand(band, startMs, midpoint);
    const right = sliceBand(band, midpoint, endMs);
    return [left, right];
  }
  return [band];
}

function crossesDayPartBoundary(band: Band, tz: string): boolean {
  return dayPartBoundariesInside(band, tz).length > 0;
}

/** Return ms timestamps for day-part boundary hours that fall strictly inside band. */
function dayPartBoundariesInside(band: Band, tz: string): number[] {
  const startMs = new Date(band.startIso).getTime();
  const endMs = new Date(band.endIso).getTime();
  const startHour = fractionalHourInTz(band.startIso, tz);
  const endHour = fractionalHourInTz(band.endIso, tz);
  const boundaries: number[] = [];
  for (const dp of DAY_PARTS) {
    const candidates = [dp.startHour, dp.endHour];
    for (const h of candidates) {
      if (h > startHour && h < endHour) {
        // Map back to ms via linear interpolation across the band.
        const hoursSpan = endHour - startHour;
        const frac = (h - startHour) / hoursSpan;
        boundaries.push(startMs + frac * (endMs - startMs));
      }
    }
  }
  return Array.from(new Set(boundaries));
}

function sliceBand(band: Band, sliceStartMs: number, sliceEndMs: number): Band {
  const slots = band.slots.filter((s) => {
    const t = new Date(s.start).getTime();
    return t >= sliceStartMs && t < sliceEndMs;
  });
  if (slots.length === 0) {
    // Degenerate slice; synthesize boundary-only band.
    return {
      startIso: new Date(sliceStartMs).toISOString(),
      endIso: new Date(sliceEndMs).toISOString(),
      slots: [],
    };
  }
  return bandFromSlots(slots);
}

/** F2: pick the day-part name if ≥60% of band minutes fall inside it. */
function nameForBand(band: Band, tz: string): string {
  const startHour = fractionalHourInTz(band.startIso, tz);
  const endHour = fractionalHourInTz(band.endIso, tz);
  const totalHours = Math.max(0.001, endHour - startHour);
  for (const dp of DAY_PARTS) {
    const overlapStart = Math.max(startHour, dp.startHour);
    const overlapEnd = Math.min(endHour, dp.endHour);
    const overlap = Math.max(0, overlapEnd - overlapStart);
    if (overlap / totalHours >= NAMED_DAYPART_THRESHOLD) {
      return dp.name;
    }
  }
  return fmtTimeRange(band.startIso, band.endIso, tz);
}

export interface BinOptions {
  /** IANA tz used for day-part mapping. Must match render tz (see assertBinningTz). */
  tz: string;
  /** Meeting duration in minutes. */
  durationMinutes: number;
}

/**
 * Pure function: scored slots for one day → human window cards.
 * Slots with score > 1 (stretch+hidden) are dropped; per §12.8 item 2 the
 * guest render collapses stretch into open and hides score > 1.
 *
 * Multi-day exception (durationMinutes ≥ 1440): the scoring model is
 * calibrated for sub-day meetings; stretch/hidden scores are meaningless
 * when you need 24+ contiguous hours. Include all slots and return one
 * card per coalesced band — sub-day splitting makes no sense here.
 */
export function binSlotsIntoWindows(
  slots: BinningSlot[],
  options: BinOptions,
): WindowCard[] {
  const { tz, durationMinutes } = options;
  const durationMs = durationMinutes * 60_000;
  const isMultiDay = durationMinutes >= 24 * 60;

  const visible = isMultiDay
    ? [...slots]
    : slots.filter((s) => (s.score ?? 0) <= 1);
  if (visible.length === 0) return [];

  const bestScore = Math.min(...visible.map((s) => s.score ?? 0));
  const bands = coalesceBands(visible);

  if (isMultiDay) {
    return bands.map((band): WindowCard => {
      const isPick = band.slots.some((s) => (s.score ?? 0) === bestScore);
      const defaultStart = band.slots[0]?.start ?? band.startIso;
      const defaultEnd = new Date(new Date(defaultStart).getTime() + durationMs).toISOString();
      return {
        start: band.startIso,
        end: band.endIso,
        name: fmtTimeRange(defaultStart, defaultEnd, tz),
        defaultStart,
        defaultEnd,
        slotCount: band.slots.length,
        isPick,
      };
    });
  }

  const split: Band[] = bands.flatMap((b) => splitBand(b, durationMs, tz));

  return split.map((band): WindowCard => {
    const isPick = band.slots.some((s) => (s.score ?? 0) === bestScore);
    const defaultStart = band.slots[0]?.start ?? band.startIso;
    const defaultEnd = band.slots[0]?.end ?? new Date(new Date(defaultStart).getTime() + durationMs).toISOString();
    return {
      start: band.startIso,
      end: band.endIso,
      name: nameForBand(band, tz),
      defaultStart,
      defaultEnd,
      slotCount: band.slots.length,
      isPick,
    };
  });
}

/**
 * Sparse layout trigger — §12.6 + F6.
 * max(windows-per-day) ≤ 1 && days-with-windows > 3 → sparse.
 */
export function isSparseLayout(
  windowsByDay: Record<string, WindowCard[]>,
): boolean {
  const counts = Object.values(windowsByDay).map((w) => w.length);
  const daysWithWindows = counts.filter((n) => n > 0).length;
  const maxPerDay = counts.length === 0 ? 0 : Math.max(...counts);
  return maxPerDay <= 1 && daysWithWindows > 3;
}
