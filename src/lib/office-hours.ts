/**
 * Office Hours — per-link slot transform.
 *
 * When a negotiation session is spawned from an office-hours link, the host's
 * global scored schedule is filtered through the rule's window before being
 * offered to the guest. The transform:
 *
 *  1. Restricts offerable slots to the rule's time window + days of week.
 *  2. Overrides SOFT protection inside the window (blocked_window, off_hours,
 *     weekend). If the host declared office hours Tue 2–4pm and also has a
 *     "surfing 6–9am" blocked window, that's not a conflict — the surf block
 *     is irrelevant to the 2–4 window. But if the host marked Tue afternoons
 *     as Focus Time in the preferences, office hours override it.
 *  3. Preserves HARD protection — real calendar events (kind: "event") and
 *     declared blackout days (kind: "blackout"). Office hours never
 *     double-book a confirmed meeting or vacation day.
 *  4. Subtracts already-booked office-hours child sessions for the same link.
 *     If guest A booked 2:00 and confirmed, guest B sees 2:00 as unavailable.
 *
 * Pure, synchronous, fully deterministic. Unit tested in isolation.
 */

import type { ScoredSlot } from "./scoring";
import type { CompiledOfficeHoursLink } from "./availability-rules";

export interface ConfirmedBooking {
  /** ISO datetime (start of the booked slot) */
  start: string;
  /** ISO datetime (end of the booked slot) */
  end: string;
}

export interface ApplyOfficeHoursOptions {
  /** The rule's compiled office-hours link entry — defines window, days, duration. */
  rule: CompiledOfficeHoursLink;
  /** The host's global scored schedule for the relevant date range. */
  slots: ScoredSlot[];
  /** Confirmed bookings for the same link (subtract from offerable set). */
  confirmedBookings?: ConfirmedBooking[];
  /** IANA timezone for interpreting slot local time. Defaults to UTC. */
  timezone?: string;
}

/**
 * Apply the office-hours transform to a host's scored schedule.
 *
 * Returns a new ScoredSlot[] where:
 *  - Slots outside the window/days are dropped entirely
 *  - Slots inside the window with soft protection are re-scored to 0 (offerable)
 *  - Slots inside the window with hard protection (real events / blackouts) are preserved
 *    at their existing score so the engine still treats them as unavailable
 *  - Slots that overlap a confirmed booking for the same link are dropped
 */
export function applyOfficeHoursWindow({
  rule,
  slots,
  confirmedBookings = [],
  timezone = "UTC",
}: ApplyOfficeHoursOptions): ScoredSlot[] {
  const out: ScoredSlot[] = [];

  for (const slot of slots) {
    const slotDate = new Date(slot.start);

    // Parse the slot into local time components for the host's timezone.
    const { dayOfWeek, hour, minute } = localTimeParts(slotDate, timezone);
    const hhmm = `${pad2(hour)}:${pad2(minute)}`;

    // 1. Day filter — if rule restricts to specific days, drop others.
    if (rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(dayOfWeek)) {
      continue;
    }

    // 2. Window filter — drop slots that start before the window or at/after the end.
    if (hhmm < rule.windowStart || hhmm >= rule.windowEnd) {
      continue;
    }

    // 3. Expiry filter — don't offer past rule expiry.
    if (rule.expiryDate) {
      const slotDateOnly = slotDate.toISOString().slice(0, 10);
      if (slotDateOnly > rule.expiryDate) continue;
    }

    // 4. Hard protection stays hard — never double-book real events or blackouts.
    const isHardProtected = slot.kind === "event" || slot.kind === "blackout";

    // 5. Confirmed booking subtraction — if this slot overlaps a confirmed booking
    //    for the same office-hours link, drop it entirely (guest B sees it gone).
    if (overlapsAnyBooking(slot, confirmedBookings)) {
      continue;
    }

    // 6. Soft protection override — inside the window, force-open soft blocks.
    if (isHardProtected) {
      // Preserve the slot as-is; downstream isOfferable() will drop it.
      // We still include it so the engine can show "busy" hints in the widget
      // if desired, and so contiguous-block stitching isn't fooled.
      out.push(slot);
    } else {
      // Override soft protection: re-score to 0 (explicitly free), kind: "open".
      out.push({
        ...slot,
        score: 0,
        kind: "open",
        reason: "office hours",
      });
    }
  }

  return out;
}

/**
 * Check whether a slot overlaps any confirmed booking. Uses ISO string comparison
 * directly — safe because both values are absolute (UTC-anchored) datetimes.
 */
function overlapsAnyBooking(slot: ScoredSlot, bookings: ConfirmedBooking[]): boolean {
  if (bookings.length === 0) return false;
  for (const b of bookings) {
    // Overlap iff slot.start < booking.end AND slot.end > booking.start
    if (slot.start < b.end && slot.end > b.start) return true;
  }
  return false;
}

/**
 * Extract day-of-week + hour + minute for a UTC date in the given timezone.
 * Uses Intl.DateTimeFormat so DST is handled correctly without a date library.
 */
function localTimeParts(
  date: Date,
  timezone: string,
): { dayOfWeek: number; hour: number; minute: number } {
  // Intl returns parts as strings — parse them out.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value || "Sun";
  const hourStr = parts.find((p) => p.type === "hour")?.value || "00";
  const minuteStr = parts.find((p) => p.type === "minute")?.value || "00";

  // Intl sometimes returns "24" for midnight in 24h mode — normalize to 0.
  const hour = parseInt(hourStr, 10) % 24;
  const minute = parseInt(minuteStr, 10);

  const DAY_MAP: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = DAY_MAP[weekday] ?? 0;

  return { dayOfWeek, hour, minute };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Generate a unique link code for an office-hours rule. Uses the same nanoid-style
 * alphabet as contextual link codes for visual consistency in URLs.
 *
 * Format: 8 lowercase alphanumeric chars (collision-resistant enough for
 * per-user scoping; DB enforces uniqueness via the unique constraint on code).
 */
export function generateOfficeHoursLinkCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
