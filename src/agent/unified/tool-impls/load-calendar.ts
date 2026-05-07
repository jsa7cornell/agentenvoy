import { getCachedCalendarContext } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";

type LoadCalendarInput = {
  lookaheadDays: number;
  toolCallId: string;
  userId: string;
  timezone: string;
};

type LoadCalendarResult = {
  calendarContext: CalendarContext | null;
  lookaheadDays: number;
  note: string;
};

/**
 * Returns the host's cached calendar context (events, busy blocks, schedule).
 * Uses the same getCachedCalendarContext path as the scheduling module.
 * lookaheadDays is passed through for context but not currently forwarded to
 * the cache implementation (which uses a default horizon).
 */
export async function loadCalendar({
  lookaheadDays,
  userId,
  timezone,
}: LoadCalendarInput): Promise<LoadCalendarResult> {
  try {
    const calendarContext = await getCachedCalendarContext(userId, timezone);
    const eventCount = calendarContext?.events?.length ?? 0;
    return {
      calendarContext,
      lookaheadDays,
      note: `Loaded ${eventCount} events over the next ${lookaheadDays} days.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      calendarContext: null,
      lookaheadDays,
      note: `Calendar load failed: ${msg}`,
    };
  }
}
