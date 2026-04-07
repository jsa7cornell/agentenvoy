/**
 * Availability Scoring Engine
 *
 * Computes protection scores for 30-min slots across a 2-week window.
 * Scores range from -1 (host-preferred) to 5 (immovable).
 *
 * Base scores are deterministic given calendar events + preferences.
 * Event-level overrides (per-thread) are applied at query time by the slots endpoint.
 */

import { createHash } from "crypto";
import type { CalendarEvent } from "./calendar";

// --- Types ---

export interface ScoredSlot {
  start: string; // ISO datetime
  end: string; // ISO datetime
  score: number; // -1 to 5
  confidence: "high" | "low";
  reason: string; // e.g. "declined invite", "Focus Time", "blocked: surfing"
  eventSummary?: string; // what's in this slot (if score > 1)
}

export interface BlockedWindow {
  start: string; // "HH:MM" 24-hour
  end: string;
  days?: string[]; // short day names: "Mon", "Tue", etc.
  label?: string;
  expires?: string; // ISO date "YYYY-MM-DD"
}

export interface UserPreferences {
  timezone?: string;
  explicit?: {
    timezone?: string;
    businessHoursStart?: number; // hour, default 9
    businessHoursEnd?: number; // hour, default 18
    bufferMinutes?: number;
    blackoutDays?: string[];
    blockedWindows?: BlockedWindow[];
    currentLocation?: { label: string; until?: string };
  };
  learned?: Record<string, unknown>;
}

// --- Constants ---

/** Keywords in event titles that indicate soft holds (score 2) */
const SOFT_HOLD_KEYWORDS = [
  "focus",
  "hold",
  "block",
  "buffer",
  "deep work",
  "heads down",
  "no meetings",
  "prep",
  "writing",
];

/** Keywords in event titles that indicate flights (score 5) */
const FLIGHT_KEYWORDS = [
  "flight",
  "fly",
  "sfo",
  "lax",
  "jfk",
  "ord",
  "ewr",
  "dfw",
  "atl",
  "bos",
  "sea",
  "iah",
  "mia",
  "den",
  "phl",
  "mex",
  "sjd",
  "→",
  "✈",
];

/** Keywords that indicate sacred/immovable events */
const SACRED_KEYWORDS = ["sacred", "immovable", "do not move", "court", "legal", "deposition"];

// --- Helpers ---

/**
 * Get local time parts for a Date in a specific IANA timezone.
 * Uses Intl so it works on UTC servers (Vercel).
 */
function getLocalParts(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    minute: "numeric",
    weekday: "short",
    timeZone: tz,
  }).formatToParts(date);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const dayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const isWeekend = dayName === "Sat" || dayName === "Sun";
  return { hour, minute, dayName, isWeekend };
}

/**
 * Check if a time + day falls within a blocked window.
 */
function isInBlockedWindow(
  hour: number,
  minute: number,
  shortDay: string,
  blockedWindows: BlockedWindow[],
  todayStr: string
): BlockedWindow | null {
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  for (const w of blockedWindows) {
    // Skip expired windows
    if (w.expires && w.expires < todayStr) continue;
    // Check day filter
    if (w.days && !w.days.includes(shortDay)) continue;
    // Check time range
    if (timeStr >= w.start && timeStr < w.end) return w;
  }
  return null;
}

/**
 * Check if an event title matches any keywords (case-insensitive).
 */
function titleMatches(summary: string, keywords: string[]): boolean {
  const lower = summary.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// --- Core Scoring ---

/**
 * Score a single 30-min slot against overlapping events, blocked windows, and preferences.
 */
function scoreSlot(
  slotStart: Date,
  slotEnd: Date,
  events: CalendarEvent[],
  blockedWindows: BlockedWindow[],
  prefs: UserPreferences,
  tz: string
): ScoredSlot {
  const { hour, minute, dayName, isWeekend } = getLocalParts(slotStart, tz);
  const todayStr = new Date().toISOString().slice(0, 10);
  const bizStart = prefs.explicit?.businessHoursStart ?? 9;
  const bizEnd = prefs.explicit?.businessHoursEnd ?? 18;

  const base: ScoredSlot = {
    start: slotStart.toISOString(),
    end: slotEnd.toISOString(),
    score: 1,
    confidence: "high",
    reason: "open",
  };

  // Weekends = score 4
  if (isWeekend) {
    return { ...base, score: 4, reason: "weekend" };
  }

  // Outside business hours = score 4
  if (hour < bizStart || hour >= bizEnd) {
    return { ...base, score: 4, reason: "outside business hours" };
  }

  // Blocked windows = score 4
  const blockedMatch = isInBlockedWindow(hour, minute, dayName, blockedWindows, todayStr);
  if (blockedMatch) {
    return {
      ...base,
      score: 4,
      reason: `blocked: ${blockedMatch.label || "blocked window"}`,
      eventSummary: blockedMatch.label || undefined,
    };
  }

  // Check blackout days
  const blackoutDays = prefs.explicit?.blackoutDays;
  if (blackoutDays && blackoutDays.includes(dayName)) {
    return { ...base, score: 4, reason: `blackout day: ${dayName}` };
  }

  // Find overlapping calendar events
  const overlapping = events.filter((ev) => !ev.isAllDay && slotStart < ev.end && slotEnd > ev.start);

  if (overlapping.length === 0) {
    // No events — clean open slot, score 1
    return base;
  }

  // Score based on event characteristics
  // Priority: highest score wins (most protective)
  let bestScore = 0;
  let bestReason = "open";
  let bestConfidence: "high" | "low" = "high";
  let bestSummary: string | undefined;

  for (const ev of overlapping) {
    let evScore = 1;
    let evReason = "open";
    let evConfidence: "high" | "low" = "high";

    // Declined = explicitly free (score 0)
    if (ev.responseStatus === "declined") {
      evScore = 0;
      evReason = "declined invite";
      // Don't override higher scores from other overlapping events
      if (evScore > bestScore) continue;
      bestScore = evScore;
      bestReason = evReason;
      bestConfidence = evConfidence;
      bestSummary = ev.summary;
      continue;
    }

    // Transparent/FYI = doesn't block (score 1, context only)
    if (ev.isTransparent) {
      continue; // Don't affect score
    }

    // Flight detection (score 5)
    if (titleMatches(ev.summary, FLIGHT_KEYWORDS)) {
      evScore = 5;
      evReason = "flight";
      evConfidence = "high";
    }
    // Sacred/immovable (score 5)
    else if (titleMatches(ev.summary, SACRED_KEYWORDS)) {
      evScore = 5;
      evReason = "immovable";
      evConfidence = "high";
    }
    // Soft holds (score 2)
    else if (titleMatches(ev.summary, SOFT_HOLD_KEYWORDS)) {
      evScore = 2;
      evReason = "soft hold";
      evConfidence = "low";
    }
    // Tentative meeting (score 3)
    else if (ev.responseStatus === "tentative") {
      if ((ev.attendeeCount ?? 0) <= 2) {
        evScore = 2;
        evReason = "tentative, small meeting";
        evConfidence = "low";
      } else {
        evScore = 3;
        evReason = "tentative meeting";
        evConfidence = "low";
      }
    }
    // Recurring 1:1 (score 3, low confidence — reschedulable)
    else if (ev.isRecurring && (ev.attendeeCount ?? 0) <= 2) {
      evScore = 3;
      evReason = "recurring 1:1";
      evConfidence = "low";
    }
    // Confirmed meeting with 3+ attendees or external (score 4)
    else if ((ev.attendeeCount ?? 0) >= 3) {
      evScore = 4;
      evReason = "confirmed group meeting";
      evConfidence = "high";
    }
    // Default confirmed meeting (score 4)
    else {
      evScore = 4;
      evReason = "confirmed meeting";
      evConfidence = "high";
    }

    if (evScore > bestScore) {
      bestScore = evScore;
      bestReason = evReason;
      bestConfidence = evConfidence;
      bestSummary = ev.summary;
    }
  }

  return {
    ...base,
    score: bestScore,
    confidence: bestConfidence,
    reason: bestReason,
    eventSummary: bestSummary,
  };
}

// --- Schedule Computation ---

/**
 * Compute the full 2-week schedule of scored 30-min slots.
 * Returns slots for business hours only (weekends and off-hours get score 4 but are excluded from output).
 */
export function computeSchedule(
  events: CalendarEvent[],
  preferences: UserPreferences,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  persistentKnowledge: string | null
): ScoredSlot[] {
  const tz = preferences.explicit?.timezone ?? preferences.timezone ?? "America/Los_Angeles";
  const blockedWindows = (preferences.explicit?.blockedWindows ?? []) as BlockedWindow[];
  const bizStart = preferences.explicit?.businessHoursStart ?? 9;
  const bizEnd = preferences.explicit?.businessHoursEnd ?? 18;

  // Check persistent knowledge for sacred items
  // (These could override scores, but for now we rely on event title matching)

  const now = new Date();
  const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const slots: ScoredSlot[] = [];

  // Snap to next :00 or :30 boundary
  const current = new Date(now);
  const { minute: mins } = getLocalParts(current, tz);
  if (mins > 0 && mins < 30) {
    current.setMinutes(current.getMinutes() + (30 - mins), 0, 0);
  } else if (mins > 30) {
    current.setMinutes(current.getMinutes() + (60 - mins), 0, 0);
  } else {
    current.setSeconds(0, 0);
  }

  while (current < twoWeeks) {
    const { hour, isWeekend } = getLocalParts(current, tz);

    // Skip weekends and outside business hours entirely — don't include in output
    if (isWeekend || hour < bizStart || hour >= bizEnd) {
      current.setMinutes(current.getMinutes() + 30);
      continue;
    }

    const slotEnd = new Date(current.getTime() + 30 * 60 * 1000);
    const scored = scoreSlot(current, slotEnd, events, blockedWindows, preferences, tz);
    slots.push(scored);

    current.setMinutes(current.getMinutes() + 30);
  }

  return slots;
}

// --- Input Hash ---

/**
 * Compute a hash of the inputs that determine the schedule.
 * If this hash matches the stored one, the schedule doesn't need recomputation.
 */
export function computeInputHash(
  events: CalendarEvent[],
  preferences: UserPreferences
): string {
  const data = JSON.stringify({
    events: events.map((e) => ({
      id: e.id,
      start: e.start,
      end: e.end,
      summary: e.summary,
      responseStatus: e.responseStatus,
      isTransparent: e.isTransparent,
      isRecurring: e.isRecurring,
      attendeeCount: e.attendeeCount,
    })),
    blockedWindows: preferences.explicit?.blockedWindows,
    businessHoursStart: preferences.explicit?.businessHoursStart,
    businessHoursEnd: preferences.explicit?.businessHoursEnd,
    blackoutDays: preferences.explicit?.blackoutDays,
  });
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

// --- Event-Level Override Application ---

export interface SlotOverride {
  start: string; // ISO datetime
  end: string;
  score: number; // -1 (preferred) or 5 (locked out)
  label?: string;
}

export interface LinkRules {
  format?: string;
  conditionalRules?: Array<{ condition: string; rule: string }>;
  preferredDays?: string[];
  lastResort?: string[];
  preferredTimeStart?: string; // "09:00"
  preferredTimeEnd?: string; // "12:00"
  slotOverrides?: SlotOverride[];
  exclusiveSlots?: boolean; // if true, only slotOverrides with score -1 are shown
}

/**
 * Apply event-level overrides (from NegotiationLink.rules) to base scored slots.
 * Returns the filtered/adjusted slots for a specific thread.
 */
export function applyEventOverrides(
  baseSlots: ScoredSlot[],
  rules: LinkRules,
  tz: string
): ScoredSlot[] {
  let slots = [...baseSlots];

  // If exclusiveSlots, only return slots that match slotOverrides with score -1
  if (rules.exclusiveSlots && rules.slotOverrides?.length) {
    const preferred = rules.slotOverrides.filter((o) => o.score === -1);
    slots = slots.filter((slot) =>
      preferred.some((o) => {
        const oStart = new Date(o.start).getTime();
        const oEnd = new Date(o.end).getTime();
        const sStart = new Date(slot.start).getTime();
        const sEnd = new Date(slot.end).getTime();
        return sStart >= oStart && sEnd <= oEnd;
      })
    );
    // Override scores to -1 for matched slots
    return slots.map((s) => ({ ...s, score: -1, reason: "host preferred", confidence: "high" as const }));
  }

  // Apply preferredDays filter
  if (rules.preferredDays && rules.preferredDays.length > 0) {
    const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz });
    slots = slots.filter((s) => {
      const dayName = dayFmt.format(new Date(s.start));
      return rules.preferredDays!.includes(dayName);
    });
  }

  // Apply lastResort filter (remove these days if other days have slots)
  if (rules.lastResort && rules.lastResort.length > 0) {
    const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz });
    const nonLastResort = slots.filter((s) => {
      const dayName = dayFmt.format(new Date(s.start));
      return !rules.lastResort!.includes(dayName);
    });
    // Only filter if there are non-last-resort options
    if (nonLastResort.length > 0) {
      slots = nonLastResort;
    }
  }

  // Apply preferred time window
  if (rules.preferredTimeStart || rules.preferredTimeEnd) {
    slots = slots.filter((s) => {
      const { hour, minute } = getLocalParts(new Date(s.start), tz);
      const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      if (rules.preferredTimeStart && timeStr < rules.preferredTimeStart) return false;
      if (rules.preferredTimeEnd && timeStr >= rules.preferredTimeEnd) return false;
      return true;
    });
  }

  // Apply individual slot overrides (non-exclusive mode)
  if (rules.slotOverrides?.length) {
    slots = slots.map((slot) => {
      const override = rules.slotOverrides!.find((o) => {
        const oStart = new Date(o.start).getTime();
        const oEnd = new Date(o.end).getTime();
        const sStart = new Date(slot.start).getTime();
        const sEnd = new Date(slot.end).getTime();
        return sStart >= oStart && sEnd <= oEnd;
      });
      if (override) {
        return {
          ...slot,
          score: override.score,
          reason: override.label || (override.score === -1 ? "host preferred" : "host locked"),
          confidence: "high" as const,
        };
      }
      return slot;
    });
  }

  return slots;
}
