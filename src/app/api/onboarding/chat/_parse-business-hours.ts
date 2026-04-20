/**
 * Parse freetext business-hours input into integer hour boundaries +
 * optional minute offsets. Returns null if the input can't be understood.
 *
 * Accepted:
 *   "9-17", "9 - 18"
 *   "9am-5pm", "9 AM – 6 PM"
 *   "8:30am-5:30pm", "8:30 - 17:30"
 *
 * Lives in a sibling module (not route.ts) because Next.js App Router only
 * permits HTTP-verb exports from route files.
 */
export function parseCustomBusinessHours(input: string): {
  startH: number;
  endH: number;
  startMin?: number;
  endMin?: number;
} | null {
  const cleaned = input.trim().toLowerCase().replace(/\s+/g, "");
  // Split on common range separators
  const parts = cleaned.split(/–|—|-|to/).filter(Boolean);
  if (parts.length !== 2) return null;
  const start = parseClockTime(parts[0]);
  const end = parseClockTime(parts[1], start);
  if (!start || !end) return null;
  if (end.hour === 0 && end.minute === 0) return null; // nonsensical
  if (end.hour < start.hour || (end.hour === start.hour && end.minute <= start.minute)) {
    return null;
  }
  return {
    startH: start.hour,
    endH: end.hour,
    startMin: start.minute || undefined,
    endMin: end.minute || undefined,
  };
}

function parseClockTime(
  token: string,
  startCtx?: { hour: number; minute: number } | null
): { hour: number; minute: number } | null {
  const m = token.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const suffix = m[3];
  if (hour > 24 || minute > 59) return null;
  if (suffix === "am") {
    if (hour === 12) hour = 0;
  } else if (suffix === "pm") {
    if (hour < 12) hour += 12;
  } else if (startCtx && hour < startCtx.hour) {
    // Unsuffixed end that looks earlier than start → probably PM. ("9-5" → 9-17)
    if (hour + 12 <= 24) hour += 12;
  }
  if (hour > 24) return null;
  return { hour, minute };
}
