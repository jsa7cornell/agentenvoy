/**
 * Availability Scoring Engine
 *
 * Computes protection scores for 30-min slots across an 8-week window.
 * Scores range from -2 (exclusive) to 5 (immovable).
 *
 * Base scores are deterministic given calendar events + preferences.
 * Event-level overrides (per-thread) are applied at query time by the slots endpoint.
 */

import { createHash } from "crypto";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import type { CalendarEvent } from "./calendar";
import { safeTimezone } from "./timezone";

// --- Types ---

/**
 * Protection category for a slot. Score tells you how protected the slot is;
 * kind tells you WHY, which determines whether a high-priority link may
 * navigate around it.
 *
 * Hard kinds ("event", "blackout") are NEVER offerable regardless of link
 * priority — a real calendar conflict trumps any VIP. Soft kinds
 * ("blocked_window", "off_hours", "weekend") are implicit protections the
 * host set via preferences or default hours, and higher-priority links can
 * pierce them.
 */
export type SlotKind =
  | "open" // no conflict, within business hours, weekday
  | "event" // real calendar event (confirmed, tentative, OOO) — HARD
  | "blackout" // user-declared blackout day (e.g. vacation) — HARD
  | "blocked_window" // user preference block (e.g. "surfing 6-9am") — SOFT, VIP can navigate
  | "off_hours" // weekday outside business hours — SOFT
  | "weekend"; // Saturday or Sunday — SOFT

export interface ScoredSlot {
  start: string; // ISO datetime
  end: string; // ISO datetime
  score: number; // -2 to 5 (-2=exclusive, -1=preferred, 0=available, 1=open+context, 2=soft, 3=friction, 4=protected, 5=immovable)
  confidence: "high" | "low";
  reason: string; // e.g. "declined invite", "Focus Time", "blocked: surfing"
  eventSummary?: string; // what's in this slot (if score > 1)
  /**
   * Protection category. Optional for backward compat with cached slots from
   * before this field existed — consumers should treat missing kind as "open"
   * and fall through to today's score-based filtering.
   */
  kind?: SlotKind;
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
  phone?: string; // host phone number (with country code) — default location for phone calls
  videoProvider?: "google-meet" | "zoom"; // preferred video conferencing platform
  zoomLink?: string; // personal Zoom meeting link (e.g. https://zoom.us/j/1234567890)
  defaultDuration?: number; // default meeting length in minutes (15, 30, 45, 60, 90)
  explicit?: {
    timezone?: string;
    businessHoursStart?: number; // hour, default 9
    businessHoursEnd?: number; // hour, default 18
    bufferMinutes?: number;
    blackoutDays?: string[];
    blockedWindows?: BlockedWindow[];
    defaultLocation?: string; // host's home base (private — never surfaced to guests)
    activeCalendarIds?: string[]; // if set, only these calendars affect availability
    phone?: string;
    videoProvider?: "google-meet" | "zoom";
    zoomLink?: string;
    defaultDuration?: number;
  };
  learned?: Record<string, unknown>;
}

export interface CompiledBuffer {
  beforeMinutes: number;
  afterMinutes: number;
  eventFilter: string; // "in-person", "all", or keyword match
}

export interface CompiledPriorityBucket {
  level: "high" | "low";
  keywords: string[];
}

export interface CompiledRules {
  blockedWindows: BlockedWindow[];
  buffers: CompiledBuffer[];
  priorityBuckets: CompiledPriorityBucket[];
  businessHoursStart?: number;
  businessHoursEnd?: number;
  blackoutDays?: string[]; // ISO dates "YYYY-MM-DD"
  ambiguities: string[];
  compiledAt: string; // ISO datetime
}

// --- Preference Compiler ---

/**
 * Use an LLM to compile free-text preferences into deterministic scheduling rules.
 * Called on preference save — results are stored on the user record and consumed by computeSchedule().
 */
export async function compilePreferenceRules(
  persistentKnowledge: string | null,
  upcomingSchedulePreferences: string | null,
  timezone?: string
): Promise<CompiledRules> {
  const tz = timezone ?? "America/Los_Angeles";
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });

  const texts: string[] = [];
  if (persistentKnowledge?.trim()) texts.push(`General preferences:\n${persistentKnowledge}`);
  if (upcomingSchedulePreferences?.trim()) texts.push(`Schedule context:\n${upcomingSchedulePreferences}`);

  if (texts.length === 0) {
    return { blockedWindows: [], buffers: [], priorityBuckets: [], ambiguities: [], compiledAt: new Date().toISOString() };
  }

  const { text } = await generateText({
    model: envoyModel("claude-haiku-4-5-20251001"),
    system: `You extract deterministic scheduling rules from natural-language preferences.
Today is ${today}. The host's timezone is ${tz}.

Return ONLY valid JSON matching this schema — no markdown, no explanation:
{
  "blockedWindows": [
    {
      "start": "HH:MM",       // 24-hour, e.g. "00:00"
      "end": "HH:MM",         // 24-hour, e.g. "10:00"
      "days": ["Mon","Tue"],   // optional — short day names, omit for all days
      "label": "surfing",      // brief reason
      "expires": "YYYY-MM-DD"  // REQUIRED for one-off items. Omit ONLY for explicitly permanent rules ("every", "always", "weekly").
    }
  ],
  "buffers": [
    {
      "beforeMinutes": 45,     // buffer before matching events
      "afterMinutes": 45,      // buffer after matching events
      "eventFilter": "in-person" // "in-person" = events with a location, "all" = all events, or keyword to match in title
    }
  ],
  "priorityBuckets": [
    {
      "level": "high",         // "high" = immovable, "low" = flexible/reschedulable
      "keywords": ["investor", "board prep", "Sarah Chen"]  // matched against event title and attendees
    }
  ],
  "businessHoursStart": 7,     // optional — hour (24h) when availability begins
  "businessHoursEnd": 21,      // optional — hour (24h) when availability ends
  "blackoutDays": ["YYYY-MM-DD"],  // optional — specific dates with no availability
  "ambiguities": ["description of unclear item"]  // things you cannot resolve confidently
}

Rules:
- Convert relative dates ("next week", "this Thursday") to absolute dates using today's date.
- "protect until 10am" = blocked window 00:00–10:00
- "never before 7am" = businessHoursStart: 7
- "no calls after 9pm" = businessHoursEnd: 21
- "out of office Apr 10-12" = blackoutDays for each date
- BUFFERS ARE CRITICAL: "buffer X min before/after [type] meetings" = buffers entry. "f2f", "face to face", "in-person" all map to eventFilter "in-person". Buffers are RUNTIME rules — they are applied dynamically when events exist on the calendar. ALWAYS emit a buffers entry for buffer preferences. NEVER put buffer rules in ambiguities — they work at scheduling time, not compile time.
- "high priority: X, Y, Z" = priorityBuckets with level "high". "low priority: X, Y" = level "low".
- Date-bounded rules (trips, events) MUST have "expires" set to the last date.
- Day-bounded rules (daily activities) should use "days" array.
- ONE-OFF ITEMS: if the preference mentions a specific date/day without "every", "always", or "weekly", it is ONE-OFF. Set "expires" to the end of that day or week. Example: "yoga Wed 7-9 AM" (without "every") → expires end of this week. "I always surf 8-10" → no expires.
- If a preference is TRULY ambiguous (unclear timezone, vague duration, contradictory), add to "ambiguities" and DO NOT generate a rule for it. But do NOT mark dynamic/runtime rules (buffers, priority buckets) as ambiguous just because you can't see the calendar — those rules are applied later.
- Only extract what is clearly stated. Do not infer unstated preferences.`,
    prompt: texts.join("\n\n"),
  });

  try {
    // Strip markdown code fences if the LLM wrapped its response
    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      blockedWindows: (parsed.blockedWindows ?? []).map((w: Record<string, unknown>) => ({
        start: String(w.start ?? "00:00"),
        end: String(w.end ?? "23:59"),
        ...(w.days ? { days: w.days as string[] } : {}),
        ...(w.label ? { label: String(w.label) } : {}),
        ...(w.expires ? { expires: String(w.expires) } : {}),
      })),
      buffers: (parsed.buffers ?? []).map((b: Record<string, unknown>) => ({
        beforeMinutes: Number(b.beforeMinutes ?? 0),
        afterMinutes: Number(b.afterMinutes ?? 0),
        eventFilter: String(b.eventFilter ?? "all"),
      })),
      priorityBuckets: (parsed.priorityBuckets ?? []).map((p: Record<string, unknown>) => ({
        level: p.level === "low" ? "low" as const : "high" as const,
        keywords: Array.isArray(p.keywords) ? p.keywords.map(String) : [],
      })),
      businessHoursStart: typeof parsed.businessHoursStart === "number" ? parsed.businessHoursStart : undefined,
      businessHoursEnd: typeof parsed.businessHoursEnd === "number" ? parsed.businessHoursEnd : undefined,
      blackoutDays: Array.isArray(parsed.blackoutDays) ? parsed.blackoutDays.map(String) : undefined,
      ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities.map(String) : [],
      compiledAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error("[compilePreferenceRules] LLM parse failed:", e, "Raw text:", text);
    // LLM returned unparseable response — fall back to regex extraction
    const fallback = extractTemporalOverrides(persistentKnowledge, upcomingSchedulePreferences);
    return {
      blockedWindows: fallback.extraBlockedWindows,
      buffers: [],
      priorityBuckets: [],
      businessHoursStart: fallback.adjustedBizHours?.start,
      businessHoursEnd: fallback.adjustedBizHours?.end,
      ambiguities: ["Preference compiler returned invalid response — using regex fallback"],
      compiledAt: new Date().toISOString(),
    };
  }
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
 * Get the current date as YYYY-MM-DD in a specific IANA timezone.
 * Critical: must use Intl, NOT toISOString() which returns UTC date.
 */
function getLocalDateStr(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  }).format(date); // en-CA formats as YYYY-MM-DD
  return parts;
}

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
  tz: string,
  buffers: CompiledBuffer[] = [],
  priorityBuckets: CompiledPriorityBucket[] = [],
): ScoredSlot {
  const { hour, minute, dayName } = getLocalParts(slotStart, tz);
  const todayStr = getLocalDateStr(new Date(), tz);

  const base: ScoredSlot = {
    start: slotStart.toISOString(),
    end: slotEnd.toISOString(),
    score: 0,
    confidence: "high",
    reason: "open",
    kind: "open",
  };

  // NOTE: weekend and off-hours checks used to short-circuit here. They've
  // been lifted out of scoreSlot entirely — computeSchedule applies the hours
  // protection layer AFTER scoring, and only to otherwise-open slots. This
  // lets a real event on Saturday or at 7am still be scored as an event
  // (hard protection) rather than collapsing into generic weekend/off-hours
  // protection (soft, pierceable by high-priority links).

  // Blocked windows = score 4, kind: blocked_window (SOFT — VIP can navigate)
  const blockedMatch = isInBlockedWindow(hour, minute, dayName, blockedWindows, todayStr);
  if (blockedMatch) {
    return {
      ...base,
      score: 4,
      reason: `blocked: ${blockedMatch.label || "blocked window"}`,
      eventSummary: blockedMatch.label || undefined,
      kind: "blocked_window",
    };
  }

  // Check blackout days (ISO date strings like "2026-04-14") — HARD
  const blackoutDays = prefs.explicit?.blackoutDays;
  if (blackoutDays && blackoutDays.length > 0) {
    const slotDateStr = getLocalDateStr(slotStart, tz);
    if (blackoutDays.includes(slotDateStr)) {
      return { ...base, score: 5, reason: `blackout day: ${slotDateStr}`, kind: "blackout" };
    }
  }

  // Check all-day blocking events (OOO, etc.) — real calendar items, HARD
  const allDayBlocking = events.filter((ev) =>
    ev.isAllDay &&
    !ev.isTransparent &&
    ev.responseStatus !== "declined" &&
    slotStart < ev.end &&
    slotEnd > ev.start &&
    (ev.eventType === "outOfOffice" || (!ev.eventType && !ev.isTransparent))
  );
  if (allDayBlocking.length > 0) {
    const ooo = allDayBlocking.find((ev) => ev.eventType === "outOfOffice");
    if (ooo) {
      return { ...base, score: 5, reason: "out of office", eventSummary: ooo.summary, kind: "event" };
    }
    // Non-OOO all-day accepted events (vacations, conferences, etc.)
    const accepted = allDayBlocking.find((ev) => ev.responseStatus === "accepted");
    if (accepted) {
      return { ...base, score: 5, reason: `all-day event: ${accepted.summary}`, eventSummary: accepted.summary, kind: "event" };
    }
  }

  // Find overlapping calendar events (timed, not all-day)
  const overlapping = events.filter((ev) => !ev.isAllDay && slotStart < ev.end && slotEnd > ev.start);

  if (overlapping.length === 0) {
    // No direct overlap — check buffer zones around nearby events
    if (buffers.length > 0) {
      for (const buf of buffers) {
        const beforeMs = buf.beforeMinutes * 60 * 1000;
        const afterMs = buf.afterMinutes * 60 * 1000;

        // Find events whose buffer zones overlap this slot
        const bufferedEvent = events.find((ev) => {
          if (ev.isAllDay || ev.responseStatus === "declined" || ev.isTransparent) return false;

          // Check event filter
          if (buf.eventFilter === "in-person") {
            if (!ev.location) return false;
          } else if (buf.eventFilter !== "all") {
            // Keyword match on event title
            if (!ev.summary.toLowerCase().includes(buf.eventFilter.toLowerCase())) return false;
          }

          // Check if slot falls in the buffer zone: [event.start - before, event.end + after]
          const bufferStart = new Date(ev.start.getTime() - beforeMs);
          const bufferEnd = new Date(ev.end.getTime() + afterMs);
          return slotStart < bufferEnd && slotEnd > bufferStart &&
                 !(slotStart < ev.end && slotEnd > ev.start); // Exclude direct overlap (handled below)
        });

        if (bufferedEvent) {
          return {
            ...base,
            score: 3,
            confidence: "high",
            reason: `buffer: ${buf.beforeMinutes}m before / ${buf.afterMinutes}m after`,
            eventSummary: bufferedEvent.summary,
            kind: "event",
          };
        }
      }
    }
    // No events, no buffers — clean open slot, score 0
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

    // Priority bucket overrides — check if event matches high/low priority keywords
    for (const bucket of priorityBuckets) {
      const matches = bucket.keywords.some((kw) =>
        ev.summary.toLowerCase().includes(kw.toLowerCase())
      );
      if (matches) {
        if (bucket.level === "high") {
          evScore = 5;
          evReason = "high priority";
          evConfidence = "high";
        } else if (bucket.level === "low" && evScore >= 3) {
          // Only downgrade if currently protected — don't downgrade already-low scores
          evScore = 2;
          evReason = "low priority (flexible)";
          evConfidence = "low";
        }
        break; // First matching bucket wins
      }
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
    kind: bestScore === 0 && bestReason === "declined invite" ? "open" : "event",
  };
}

/**
 * Hours-protection layer — applied after scoreSlot(), ONLY to slots that
 * come back as kind: "open". A weekday slot at 7 AM with nothing on the
 * calendar gets bumped to off_hours/2; a Saturday afternoon slot with
 * nothing scheduled gets bumped to weekend/3. Real events on those same
 * slots stay classified as events and are unaffected.
 *
 * Per user direction: weekend daytime is slightly MORE protected than
 * weekday off-hours near the business window, so weekend daytime scores 3
 * (medium friction) while weekday 1–2h outside biz hours scores 2 (soft).
 * Weekend early/late and weekday deep off-hours (3h+ from biz window) score 4.
 */
function hoursProtectionLayer(
  hour: number,
  isWeekend: boolean,
  bizStart: number,
  bizEnd: number
): { score: number; reason: string; kind: SlotKind } | null {
  if (isWeekend) {
    // Weekend daytime: aligned with typical biz hours gets score 3.
    // Weekend early/late: score 4.
    if (hour >= bizStart && hour < bizEnd) {
      return { score: 3, reason: "weekend", kind: "weekend" };
    }
    return { score: 4, reason: "weekend (off-hours)", kind: "weekend" };
  }
  // Weekday within biz hours → no bump.
  if (hour >= bizStart && hour < bizEnd) return null;
  // Weekday outside biz hours. Distance from the nearest biz-hour edge
  // in whole hours; 0 means immediately adjacent, 3+ means deep off-hours.
  const distance = hour < bizStart ? bizStart - hour - 1 : hour - bizEnd;
  if (distance <= 0) {
    return { score: 2, reason: "just outside business hours", kind: "off_hours" };
  }
  if (distance <= 2) {
    return { score: 3, reason: "off hours", kind: "off_hours" };
  }
  return { score: 4, reason: "early morning / late evening", kind: "off_hours" };
}

// --- Link priority (per-link protection ceiling) ---

/**
 * Priority tier for a negotiation link. Governs which protection layers the
 * link can navigate around. Unset defaults to "normal" — identical to
 * today's behavior for existing generic links.
 */
export type LinkPriority = "normal" | "high" | "vip";

/**
 * Offerability configuration per priority tier. This is the single source of
 * truth for "what can a VIP guest see that a normal guest can't." Keep the
 * mapping deterministic and unit-testable.
 */
export interface PriorityConfig {
  maxScore: number; // max slot score that's offerable (inclusive)
  allowWeekends: boolean;
  allowOffHours: boolean;
  allowBlockedWindows: boolean;
}

const PRIORITY_CONFIGS: Record<LinkPriority, PriorityConfig> = {
  normal: {
    maxScore: 3, // today's default — weekday biz + friction meetings
    allowWeekends: false,
    allowOffHours: false,
    allowBlockedWindows: false,
  },
  high: {
    // Weekend daytime (score 3) and weekday just-outside-biz (score 2) open up.
    // Deep off-hours (score 4) and blocked windows stay protected.
    maxScore: 3,
    allowWeekends: true,
    allowOffHours: true,
    allowBlockedWindows: false,
  },
  vip: {
    // Full envelope: weekend early/late, weekday deep off-hours, AND the
    // host's own implicit blocked windows all become navigable. Real
    // calendar events stay hard (event + blackout are never offerable).
    maxScore: 4,
    allowWeekends: true,
    allowOffHours: true,
    allowBlockedWindows: true,
  },
};

export function getPriorityConfig(priority: LinkPriority | undefined | null): PriorityConfig {
  if (!priority) return PRIORITY_CONFIGS.normal;
  return PRIORITY_CONFIGS[priority] ?? PRIORITY_CONFIGS.normal;
}

const HARD_KINDS: ReadonlySet<SlotKind> = new Set<SlotKind>(["event", "blackout"]);

/**
 * Decide whether a single slot is offerable to the guest given the link's
 * priority config. Hard kinds (real events, blackouts) are ALWAYS off-limits,
 * regardless of priority. Soft kinds check a per-kind allow flag. Final
 * score ceiling is applied last. Slots with score -1 or -2 (host exclusive
 * / preferred overrides) are always offerable — the host explicitly chose
 * them and the normal filter doesn't apply.
 */
export function isOfferable(slot: ScoredSlot, config: PriorityConfig): boolean {
  // Host-explicit overrides win regardless of kind/score.
  if (slot.score < 0) return true;
  const kind: SlotKind = slot.kind ?? "open";
  if (HARD_KINDS.has(kind)) return false;
  if (kind === "weekend" && !config.allowWeekends) return false;
  if (kind === "off_hours" && !config.allowOffHours) return false;
  if (kind === "blocked_window" && !config.allowBlockedWindows) return false;
  return slot.score <= config.maxScore;
}

// --- Temporal Extraction from Knowledge Base ---

interface TemporalOverrides {
  extraBlockedWindows: BlockedWindow[];
  adjustedBizHours?: { start?: number; end?: number };
}

/**
 * Extract hard temporal signals from free-text knowledge fields.
 * Conservative — only extracts clear time-based patterns, not ambiguous preferences.
 * Ambiguous preferences ("I prefer afternoons") stay in the LLM prompt layer.
 */
export function extractTemporalOverrides(
  persistentKnowledge: string | null,
  upcomingSchedulePreferences: string | null
): TemporalOverrides {
  const extraBlockedWindows: BlockedWindow[] = [];
  let adjustedBizHours: { start?: number; end?: number } | undefined;

  const texts = [persistentKnowledge, upcomingSchedulePreferences].filter(Boolean) as string[];

  for (const text of texts) {
    const lower = text.toLowerCase();

    // Pattern: "no meetings before X" or "no calls before X"
    const noBeforeMatch = lower.match(/no (?:meetings?|calls?) before (\d{1,2})(?::(\d{2}))?\s*(?:am|AM)?/);
    if (noBeforeMatch) {
      const hour = parseInt(noBeforeMatch[1], 10);
      adjustedBizHours = { ...adjustedBizHours, start: hour };
    }

    // Pattern: "no meetings after X" or "no calls after X PM"
    const noAfterMatch = lower.match(/no (?:meetings?|calls?) after (\d{1,2})(?::(\d{2}))?\s*(?:pm|PM)?/);
    if (noAfterMatch) {
      let hour = parseInt(noAfterMatch[1], 10);
      if (hour <= 12 && lower.includes("pm")) hour += 12;
      if (hour < 12) hour += 12; // assume PM for "no meetings after 5"
      adjustedBizHours = { ...adjustedBizHours, end: hour };
    }

    // Pattern: "I surf/run/workout [time]-[time]" or "surf from X to Y"
    const activityMatch = text.match(
      /(?:i |my )?(?:surf|run|workout|exercise|gym|swim|yoga|meditat(?:e|ion))(?:s|ing)?\s+(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:[-–to]+)\s*(\d{1,2})(?::(\d{2}))?\s*(?:am|AM|pm|PM)?/i
    );
    if (activityMatch) {
      const startH = parseInt(activityMatch[1], 10);
      const startM = activityMatch[2] ? parseInt(activityMatch[2], 10) : 0;
      const endH = parseInt(activityMatch[3], 10);
      const endM = activityMatch[4] ? parseInt(activityMatch[4], 10) : 0;
      const label = activityMatch[0].trim().replace(/^(?:i |my )/i, "");
      extraBlockedWindows.push({
        start: `${String(startH).padStart(2, "0")}:${String(startM).padStart(2, "0")}`,
        end: `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`,
        label,
      });
    }

    // Pattern: "out of office [date] to/through [date]" or "OOO [date]-[date]"
    const oooMatch = text.match(
      /(?:out of office|ooo|away|traveling|travel)\s+(?:from\s+)?(\w+ \d{1,2})\s*(?:[-–]|to|through)\s*(\w+ \d{1,2})/i
    );
    if (oooMatch) {
      // Store as a note — actual date parsing requires knowing the year context
      // This pattern is best handled by the LLM + blockedWindows set via chat
    }
  }

  return { extraBlockedWindows, adjustedBizHours };
}

// --- Schedule Computation ---

/**
 * Compute the full 8-week schedule of scored 30-min slots.
 * Returns slots for business hours only (weekends and off-hours get score 4 but are excluded from output).
 */
export function computeSchedule(
  events: CalendarEvent[],
  preferences: UserPreferences,
  persistentKnowledge: string | null,
  upcomingSchedulePreferences?: string | null
): ScoredSlot[] {
  // Canonical path only: preferences.explicit.timezone. Legacy top-level
  // field is intentionally ignored here — if data exists there, the GET
  // sites will log a warning and migration will move it.
  const tz = safeTimezone(preferences.explicit?.timezone);
  const blockedWindows = [...((preferences.explicit?.blockedWindows ?? []) as BlockedWindow[])];
  let bizStart = preferences.explicit?.businessHoursStart ?? 9;
  let bizEnd = preferences.explicit?.businessHoursEnd ?? 18;

  // Use compiled rules from LLM preference compiler (stored on user.preferences.compiled)
  const compiled = (preferences as Record<string, unknown>).compiled as CompiledRules | undefined;
  const buffers: CompiledBuffer[] = compiled?.buffers ?? [];
  const priorityBuckets: CompiledPriorityBucket[] = compiled?.priorityBuckets ?? [];

  // Diagnostic logging for buffer/priority debugging
  if (compiled) {
    const eventsWithLocation = events.filter((e) => !!e.location).length;
    console.log(`[computeSchedule] compiled: ${compiled.blockedWindows.length} blocked, ${buffers.length} buffers, ${priorityBuckets.length} priorities | ${events.length} events (${eventsWithLocation} with location)`);
    if (buffers.length > 0) {
      console.log(`[computeSchedule] buffers:`, JSON.stringify(buffers));
    }
  } else {
    console.log(`[computeSchedule] No compiled rules found on preferences`);
  }

  if (compiled) {
    blockedWindows.push(...(compiled.blockedWindows ?? []));
    if (compiled.businessHoursStart !== undefined) bizStart = compiled.businessHoursStart;
    if (compiled.businessHoursEnd !== undefined) bizEnd = compiled.businessHoursEnd;
    if (compiled.blackoutDays?.length) {
      const existingBlackout = preferences.explicit?.blackoutDays ?? [];
      preferences = {
        ...preferences,
        explicit: { ...preferences.explicit, blackoutDays: [...existingBlackout, ...compiled.blackoutDays] },
      };
    }
  } else {
    // Fallback: regex extraction if no compiled rules available
    const temporal = extractTemporalOverrides(persistentKnowledge, upcomingSchedulePreferences ?? null);
    blockedWindows.push(...temporal.extraBlockedWindows);
    if (temporal.adjustedBizHours?.start !== undefined) bizStart = temporal.adjustedBizHours.start;
    if (temporal.adjustedBizHours?.end !== undefined) bizEnd = temporal.adjustedBizHours.end;
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + 56 * 24 * 60 * 60 * 1000); // 8 weeks
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

  // Generation envelope. We now compute the full outer window and classify
  // each slot with a `kind` so the composer can decide at query time whether
  // to surface it based on link priority. GEN_START/GEN_END cap the outer
  // edge — nothing earlier or later is ever scored, even for VIP links.
  const GEN_START = 6;
  const GEN_END = 23; // 6 AM through 11 PM (last slot starts at 22:30)

  while (current < horizon) {
    const { hour, isWeekend } = getLocalParts(current, tz);

    // Hard gate — outside the generation envelope, no slot exists.
    if (hour < GEN_START || hour >= GEN_END) {
      current.setMinutes(current.getMinutes() + 30);
      continue;
    }

    const slotEnd = new Date(current.getTime() + 30 * 60 * 1000);
    const scored = scoreSlot(
      current,
      slotEnd,
      events,
      blockedWindows,
      preferences,
      tz,
      buffers,
      priorityBuckets
    );

    // Apply the hours-protection layer AFTER scoreSlot, ONLY to otherwise-open
    // slots. Real events, blackouts, and blocked windows keep their existing
    // classification — they're more specific than "it's a weekend".
    if (scored.kind === "open") {
      const layer = hoursProtectionLayer(hour, isWeekend, bizStart, bizEnd);
      if (layer) {
        scored.score = layer.score;
        scored.reason = layer.reason;
        scored.kind = layer.kind;
      }
    }

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
  preferences: UserPreferences,
  persistentKnowledge?: string | null,
  upcomingSchedulePreferences?: string | null
): string {
  const data = JSON.stringify({
    // Bump this version whenever the slot shape or scoring model changes in
    // a way that invalidates cached ComputedSchedule rows. Hashing it in
    // forces recomputation on the next session without a manual migration.
    // v2: added SlotKind + hours-protection layer + full envelope generation.
    scheduleVersion: "v2",
    events: events.map((e) => ({
      id: e.id,
      start: e.start,
      end: e.end,
      summary: e.summary,
      location: e.location,
      responseStatus: e.responseStatus,
      isTransparent: e.isTransparent,
      isRecurring: e.isRecurring,
      attendeeCount: e.attendeeCount,
      eventType: e.eventType,
      isAllDay: e.isAllDay,
    })),
    blockedWindows: preferences.explicit?.blockedWindows,
    businessHoursStart: preferences.explicit?.businessHoursStart,
    businessHoursEnd: preferences.explicit?.businessHoursEnd,
    blackoutDays: preferences.explicit?.blackoutDays,
    persistentKnowledge: persistentKnowledge || null,
    upcomingSchedulePreferences: upcomingSchedulePreferences || null,
    compiled: (preferences as Record<string, unknown>).compiled ?? null,
  });
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

// --- Event-Level Override Application ---

export interface SlotOverride {
  start: string; // ISO datetime
  end: string;
  score: number; // -2 (exclusive), -1 (preferred), or 5 (locked out)
  label?: string;
}

export interface LinkRules {
  format?: string;
  conditionalRules?: Array<{ condition: string; rule: string }>;
  /** Short day names: "Mon", "Tue", etc. `normalizeLinkRules()` coerces any input shape. */
  preferredDays?: string[];
  /** Short day names: "Mon", "Tue", etc. */
  lastResort?: string[];
  preferredTimeStart?: string; // "09:00"
  preferredTimeEnd?: string; // "12:00"
  /** Inclusive date window in host's local calendar. "YYYY-MM-DD". */
  dateRange?: { start?: string; end?: string };
  slotOverrides?: SlotOverride[];
  /** @deprecated Use score -2 in slotOverrides instead. Kept for backward compat. */
  exclusiveSlots?: boolean;
  /**
   * Link priority tier — governs which protection layers this link can
   * navigate around. Unset defaults to "normal" (today's behavior). See
   * {@link LinkPriority} and {@link getPriorityConfig}.
   */
  priority?: LinkPriority;
}

// Canonical short day-name table. All persisted `preferredDays` / `lastResort` /
// `blockedWindows.days` values use this form.
const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SHORT_DAY_SET = new Set<string>(SHORT_DAY_NAMES);

/**
 * Coerce any day-name input ("Monday", "mon", "MON", "Mon") to canonical short
 * form ("Mon"). Returns `null` for unrecognized input so callers can drop
 * garbage rather than mis-match the filter.
 */
export function normalizeDayName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const prefix = trimmed.slice(0, 3).toLowerCase();
  const match = SHORT_DAY_NAMES.find((d) => d.toLowerCase() === prefix);
  return match ?? null;
}

/**
 * Normalize a LinkRules object for persistence. Coerces day-name arrays to
 * short form and drops a `dateRange` that is structurally malformed. Safe to
 * call on unknown input — unknown keys are preserved as-is.
 */
export function normalizeLinkRules(
  input: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = { ...input };

  const normalizeDayArray = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const cleaned = raw
      .map(normalizeDayName)
      .filter((d): d is string => d !== null);
    // De-dupe while preserving order.
    return Array.from(new Set(cleaned));
  };

  const pd = normalizeDayArray(input.preferredDays);
  if (pd !== undefined) out.preferredDays = pd;

  const lr = normalizeDayArray(input.lastResort);
  if (lr !== undefined) out.lastResort = lr;

  // priority: drop anything that isn't one of the three canonical values.
  // Undefined/missing is valid — it maps to "normal" at read time.
  const pr = input.priority;
  if (pr === "normal" || pr === "high" || pr === "vip") {
    out.priority = pr;
  } else if (pr !== undefined) {
    delete out.priority;
  }

  // dateRange: keep only if it's an object with at least one valid ISO date.
  const dr = input.dateRange;
  if (dr && typeof dr === "object") {
    const { start, end } = dr as { start?: unknown; end?: unknown };
    const isIsoDate = (v: unknown): v is string =>
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const cleaned: { start?: string; end?: string } = {};
    if (isIsoDate(start)) cleaned.start = start;
    if (isIsoDate(end)) cleaned.end = end;
    if (cleaned.start || cleaned.end) {
      out.dateRange = cleaned;
    } else {
      delete out.dateRange;
    }
  }

  return out;
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

  // Exclusive mode: score -2 in overrides, or legacy exclusiveSlots boolean
  const hasExclusive = rules.slotOverrides?.some((o) => o.score === -2);
  const isExclusiveMode = hasExclusive || (rules.exclusiveSlots && rules.slotOverrides?.length);

  if (isExclusiveMode && rules.slotOverrides?.length) {
    // In exclusive mode, only keep slots matching -2 or -1 overrides
    const exclusiveOverrides = rules.slotOverrides.filter((o) => o.score <= -1);
    slots = slots.filter((slot) =>
      exclusiveOverrides.some((o) => {
        const oStart = new Date(o.start).getTime();
        const oEnd = new Date(o.end).getTime();
        const sStart = new Date(slot.start).getTime();
        const sEnd = new Date(slot.end).getTime();
        return sStart >= oStart && sEnd <= oEnd;
      })
    );
    // Apply override scores: -2 for exclusive, -1 for preferred.
    // Reset kind to "open" so the priority filter treats host-explicit picks
    // as always-offerable (isOfferable also short-circuits on score < 0, but
    // keeping kind coherent helps downstream UI/logging).
    return slots.map((s) => {
      const match = exclusiveOverrides.find((o) => {
        const oStart = new Date(o.start).getTime();
        const oEnd = new Date(o.end).getTime();
        const sStart = new Date(s.start).getTime();
        const sEnd = new Date(s.end).getTime();
        return sStart >= oStart && sEnd <= oEnd;
      });
      // Legacy exclusiveSlots: treat -1 overrides as -2
      const score = hasExclusive ? (match?.score ?? -1) : -2;
      return {
        ...s,
        score,
        reason: match?.label || (score === -2 ? "host exclusive" : "host preferred"),
        confidence: "high" as const,
        kind: "open" as const,
      };
    });
  }

  // Apply dateRange filter (inclusive in host tz).
  if (rules.dateRange && (rules.dateRange.start || rules.dateRange.end)) {
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz,
    });
    const { start, end } = rules.dateRange;
    slots = slots.filter((s) => {
      const localDate = dateFmt.format(new Date(s.start)); // YYYY-MM-DD
      if (start && localDate < start) return false;
      if (end && localDate > end) return false;
      return true;
    });
  }

  // Apply preferredDays filter. Tolerate any day-name shape on read via
  // normalizeDayName — persisted values are short form, but old rows or
  // hand-written rules might not be.
  if (rules.preferredDays && rules.preferredDays.length > 0) {
    const allowed = new Set(
      rules.preferredDays
        .map((d) => normalizeDayName(d))
        .filter((d): d is string => d !== null && SHORT_DAY_SET.has(d))
    );
    if (allowed.size > 0) {
      const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz });
      slots = slots.filter((s) => allowed.has(dayFmt.format(new Date(s.start))));
    }
  }

  // Apply lastResort filter (remove these days if other days have slots)
  if (rules.lastResort && rules.lastResort.length > 0) {
    const lastResortSet = new Set(
      rules.lastResort
        .map((d) => normalizeDayName(d))
        .filter((d): d is string => d !== null && SHORT_DAY_SET.has(d))
    );
    if (lastResortSet.size > 0) {
      const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz });
      const nonLastResort = slots.filter(
        (s) => !lastResortSet.has(dayFmt.format(new Date(s.start)))
      );
      // Only filter if there are non-last-resort options
      if (nonLastResort.length > 0) {
        slots = nonLastResort;
      }
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
