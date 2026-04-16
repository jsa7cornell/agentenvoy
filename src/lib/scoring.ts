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
 * Factual category for a slot — what IS it. Useful for UI labels and debug
 * output. The two-function offerability logic below reads `blockCost` and
 * `firmness` instead; kind is kept for human-readable reasons and the
 * dashboard availability heatmap.
 */
export type SlotKind =
  | "open" // within biz hours, no conflict
  | "event" // real calendar event (confirmed, tentative, recurring, OOO)
  | "blackout" // user-declared vacation day
  | "blocked_window" // user preference block (surfing, focus time, etc.)
  | "off_hours" // weekday outside business hours, no other block
  | "weekend"; // Saturday or Sunday, no other block

/**
 * INTRINSIC nature of a slot's protection — the primary signal the VIP
 * offerability logic keys off. Models the question "who bears the cost if
 * we break this slot?"
 *
 * - `none` — nothing to break. Slot is open.
 * - `preference` — the host alone pays the cost. Surfing, focus time,
 *   weekend off, early-morning routine. VIP can navigate preferences with
 *   host consent, because no third party is owed a renegotiation.
 * - `commitment` — a third party is expecting this slot. Tentative
 *   meetings, confirmed meetings, recurring 1:1s, family dinners, flights.
 *   Breaking a commitment always costs someone else, so VIP treats these
 *   far more conservatively (weak commitments can be proposed-with-bump,
 *   strong commitments are never touched).
 */
export type BlockCost = "none" | "preference" | "commitment";

/**
 * Within a given BlockCost, how hard the slot is to break. Set by the
 * preference compiler for blocked windows, derived from distance-from-biz
 * for off-hours slots, and read from event metadata for calendar events.
 *
 * `weak` + `preference` → score 2 (first offer, soft framing)
 * `strong` + `preference` → score 3 or 4 (stretch band depending on context)
 * `weak` + `commitment` → score 3 (stretch, propose with bump language)
 * `strong` + `commitment` → score 5 (host must resolve externally)
 */
export type BlockFirmness = "weak" | "strong";

export interface ScoredSlot {
  start: string; // ISO datetime
  end: string; // ISO datetime
  score: number; // 0-5 (negatives -2/-1 reserved for host explicit overrides)
  confidence: "high" | "low";
  reason: string; // e.g. "tentative with Bob", "Focus Time", "6 AM - 3h before biz"
  eventSummary?: string; // what's in this slot (if a real event)
  /** Factual label — shown in the dashboard heatmap. */
  kind?: SlotKind;
  /** Intrinsic nature — who pays if this slot is broken. Primary offerability signal. */
  blockCost?: BlockCost;
  /** Firmness within the block cost — how hard to break. */
  firmness?: BlockFirmness;
  /**
   * True when this slot satisfies `minDuration` but not the preferred `duration`.
   * Set by `filterByDuration` when both are provided. The widget renders these
   * with a distinct style (dashed border + tooltip) to signal "short window only".
   */
  isShortSlot?: boolean;
}

export interface BlockedWindow {
  start: string; // "HH:MM" 24-hour
  end: string;
  days?: string[]; // short day names: "Mon", "Tue", etc.
  label?: string;
  expires?: string; // ISO date "YYYY-MM-DD"
  /**
   * Intrinsic nature of this block. Defaults to "preference" when unset —
   * most user-tagged blocks are self-imposed (surfing, focus time, gym).
   * Set to "commitment" when the label references a specific other party
   * (family dinner, Mia's pickup, Dad's birthday) so the scoring engine
   * knows a third party is owed this slot.
   */
  blockCost?: BlockCost;
  /**
   * How firm this block is. Defaults to "strong" when unset — user-tagged
   * blocks exist because the host wanted them, so the conservative default
   * is to treat them as firm. The preference compiler downgrades to "weak"
   * only for labels the host explicitly marked flexible (focus time, prep,
   * buffer).
   */
  firmness?: BlockFirmness;
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
    maxOutputTokens: 512,
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
      "blockCost": "preference", // "preference" = host-only cost (host can break it for the right meeting); "commitment" = someone else is expecting this slot (family, school, specific person)
      "firmness": "strong",    // "weak" = host could break this for important meetings (focus time, prep, buffer, heads-down); "strong" = body/habit/routine/family that's genuinely hard to move (surfing, gym, prayer, family dinner, Mia's pickup)
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
- Only extract what is clearly stated. Do not infer unstated preferences.

BLOCK CLASSIFICATION — intrinsic protection tags (blockCost + firmness):
Each blockedWindow gets TWO tags that govern how Envoy reaches into it for VIP meetings. Choose carefully from the natural-language context:

blockCost:
- "commitment" — the block exists because a specific other party is expecting this slot. Examples: "family dinner", "Mia's school pickup", "Dad's birthday call", "weekly 1:1 with Sarah". If you see a specific person or group named (or strongly implied like "family"), emit commitment.
- "preference" — the block exists for the host's own reasons. Examples: "surfing 6-9am", "focus time", "gym", "prep", "prayer", "quiet hours", "heads down". No named third party. Default to preference when unclear.

firmness:
- "strong" — the host would genuinely struggle to move this. Physical/bodily commitments (surf, gym, yoga, prayer, meditation, sleep), family obligations (dinner, pickup, school), named-person commitments. Default firmness for commitment blocks is strong.
- "weak" — the host explicitly or implicitly indicated flexibility. Phrases like "I try to", "prefer", "usually hold", "focus time I'd break for the right meeting". Focus time, prep buffer, quiet hours, deep work blocks default to weak UNLESS the host said something like "really protect" or "don't touch."
- When in doubt, default to strong. Safer for the host — they can always downgrade later.

Examples:
- "I surf every morning 6-9 AM" → blockCost: preference, firmness: strong
- "focus time Mon/Wed 9-11 AM" → blockCost: preference, firmness: weak
- "family dinner 6-7 PM weekdays" → blockCost: commitment, firmness: strong
- "Mia's school pickup 3-4 PM" → blockCost: commitment, firmness: strong
- "prep buffer 30 min before meetings" → blockCost: preference, firmness: weak
- "never schedule before 10 AM — sleep" → blockCost: preference, firmness: strong
- "weekly 1:1 with Sarah Tue 2 PM" → blockCost: commitment, firmness: strong (named person)
- "I protect Tuesday mornings for deep work" → blockCost: preference, firmness: weak (implicit: "protect" but it's own work)`,
    prompt: texts.join("\n\n"),
  });

  try {
    // Strip markdown code fences if the LLM wrapped its response
    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      blockedWindows: (parsed.blockedWindows ?? []).map((w: Record<string, unknown>) => {
        // Coerce blockCost to the canonical type — accept only "preference"
        // and "commitment"; anything else (including "none", which makes no
        // sense for a blocked window) collapses to the "preference" default.
        const blockCost: BlockCost =
          w.blockCost === "commitment" ? "commitment" : "preference";
        // Firmness: accept "weak" / "strong"; default to "strong" (safer
        // for the host — weak is an explicit opt-in to flexibility).
        const firmness: BlockFirmness =
          w.firmness === "weak" ? "weak" : "strong";
        return {
          start: String(w.start ?? "00:00"),
          end: String(w.end ?? "23:59"),
          blockCost,
          firmness,
          ...(w.days ? { days: w.days as string[] } : {}),
          ...(w.label ? { label: String(w.label) } : {}),
          ...(w.expires ? { expires: String(w.expires) } : {}),
        };
      }),
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

  // Open-slot base. blockCost / firmness are filled in per return path.
  const base: ScoredSlot = {
    start: slotStart.toISOString(),
    end: slotEnd.toISOString(),
    score: 0,
    confidence: "high",
    reason: "open",
    kind: "open",
    blockCost: "none",
  };

  // NOTE: weekend and off-hours checks used to short-circuit here. They've
  // been lifted out of scoreSlot entirely — computeSchedule applies the
  // hours-protection layer AFTER scoring, and only to otherwise-open slots.
  // Real events at 7am or on Saturday still get scored as events (hard
  // protection) rather than collapsing into generic weekend/off-hours
  // protection (softer, reachable by VIP stretch).

  // Blocked windows — user-declared personal blocks like surfing, focus
  // time, family dinner. The preference compiler tags each block with
  // `blockCost` (preference vs commitment) and `firmness` (weak vs strong)
  // based on the host's natural-language description. Scoring reads those
  // tags directly, defaulting to preference:strong when unset.
  const blockedMatch = isInBlockedWindow(hour, minute, dayName, blockedWindows, todayStr);
  if (blockedMatch) {
    const blockCost: BlockCost = blockedMatch.blockCost ?? "preference";
    const firmness: BlockFirmness = blockedMatch.firmness ?? "strong";
    let score: number;
    if (blockCost === "commitment") {
      // Commitment: someone else is expecting this. Firm commitments are
      // hard (family dinner, Mia's pickup); weak commitments (rare for
      // blocked windows) land in the stretch band with bump-approval.
      score = firmness === "strong" ? 5 : 3;
    } else {
      // Preference: host-only cost. Firm preferences (surf, gym) are
      // deep-stretch; weak preferences (focus time, buffer) are first-offer.
      score = firmness === "strong" ? 4 : 2;
    }
    return {
      ...base,
      score,
      reason: `blocked: ${blockedMatch.label || "blocked window"}`,
      eventSummary: blockedMatch.label || undefined,
      kind: "blocked_window",
      blockCost,
      firmness,
    };
  }

  // Blackout days (user-declared vacation) — treat as commitment:strong
  // even though they're technically self-imposed, because the host has
  // explicitly marked the whole day off and a VIP reaching in would violate
  // the explicit boundary rather than a soft preference.
  const slotLocalDate = getLocalDateStr(slotStart, tz);

  const blackoutDays = prefs.explicit?.blackoutDays;
  if (blackoutDays && blackoutDays.length > 0) {
    if (blackoutDays.includes(slotLocalDate)) {
      return {
        ...base,
        score: 5,
        reason: `blackout day: ${slotLocalDate}`,
        kind: "blackout",
        blockCost: "commitment",
        firmness: "strong",
      };
    }
  }

  // All-day blocking events (OOO, travel) — commitment:strong.
  // Use DATE comparison, not UTC time-range overlap. Google all-day events
  // are stored as midnight UTC which bleeds across local day boundaries for
  // non-UTC timezones (e.g., a Wed event spans Tue 8 PM–Wed 8 PM in EDT).
  // The date portion of the stored ISO string IS the correct calendar date.
  const allDayBlocking = events.filter((ev) => {
    if (!ev.isAllDay || ev.isTransparent || ev.responseStatus === "declined") return false;
    if (!(ev.eventType === "outOfOffice" || (!ev.eventType && !ev.isTransparent))) return false;
    // Extract date from stored Date: "2026-04-16T00:00:00.000Z" → "2026-04-16"
    const evStartDate = ev.start.toISOString().substring(0, 10);
    const evEndDate = ev.end.toISOString().substring(0, 10);
    // Google end date is exclusive (event on Apr 16 has end "2026-04-17")
    return slotLocalDate >= evStartDate && slotLocalDate < evEndDate;
  });
  if (allDayBlocking.length > 0) {
    const ooo = allDayBlocking.find((ev) => ev.eventType === "outOfOffice");
    if (ooo) {
      return {
        ...base,
        score: 5,
        reason: "out of office",
        eventSummary: ooo.summary,
        kind: "event",
        blockCost: "commitment",
        firmness: "strong",
      };
    }
    const accepted = allDayBlocking.find((ev) => ev.responseStatus === "accepted");
    if (accepted) {
      return {
        ...base,
        score: 5,
        reason: `all-day event: ${accepted.summary}`,
        eventSummary: accepted.summary,
        kind: "event",
        blockCost: "commitment",
        firmness: "strong",
      };
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
          // Buffer zone = preference:weak (your own convenience — you'd
          // rather not be rushed to an in-person meeting). First-offer
          // tier; guest gets it without explanation.
          return {
            ...base,
            score: 2,
            confidence: "high",
            reason: `buffer: ${buf.beforeMinutes}m before / ${buf.afterMinutes}m after`,
            eventSummary: bufferedEvent.summary,
            kind: "event",
            blockCost: "preference",
            firmness: "weak",
          };
        }
      }
    }
    // No events, no buffers — clean open slot, score 0.
    return base;
  }

  // Score based on event characteristics.
  // Highest score wins (most protective). Each event contributes a
  // {score, blockCost, firmness} tuple; the slot inherits the highest.
  interface EventScore {
    score: number;
    reason: string;
    confidence: "high" | "low";
    summary?: string;
    blockCost: BlockCost;
    firmness?: BlockFirmness;
  }
  let best: EventScore = {
    score: 0,
    reason: "open",
    confidence: "high",
    blockCost: "none",
  };

  for (const ev of overlapping) {
    let ev_: EventScore;

    // Declined = explicitly free. Doesn't promote the slot's protection.
    if (ev.responseStatus === "declined") {
      ev_ = { score: 0, reason: "declined invite", confidence: "high", summary: ev.summary, blockCost: "none" };
    }
    // Transparent FYI = context only. Doesn't affect score or offerability.
    // Surfaced in the host's dashboard heatmap via the `reason` field, but
    // hidden from the guest prompt per the "don't leak host context" rule.
    else if (ev.isTransparent) {
      ev_ = { score: 1, reason: `FYI: ${ev.summary}`, confidence: "high", summary: ev.summary, blockCost: "none" };
    }
    // Flight = commitment:strong. Immovable for everyone.
    else if (titleMatches(ev.summary, FLIGHT_KEYWORDS)) {
      ev_ = { score: 5, reason: "flight", confidence: "high", summary: ev.summary, blockCost: "commitment", firmness: "strong" };
    }
    // Sacred/immovable keywords = commitment:strong.
    else if (titleMatches(ev.summary, SACRED_KEYWORDS)) {
      ev_ = { score: 5, reason: "immovable", confidence: "high", summary: ev.summary, blockCost: "commitment", firmness: "strong" };
    }
    // Soft-hold events ("Focus Time", "Hold", "Buffer") = preference:weak.
    // First-offer tier — these are reschedulable at the host's whim.
    else if (titleMatches(ev.summary, SOFT_HOLD_KEYWORDS)) {
      ev_ = { score: 2, reason: "soft hold", confidence: "low", summary: ev.summary, blockCost: "preference", firmness: "weak" };
    }
    // Tentative meeting = commitment:weak. Size determines firmness: a
    // tentative 1:1 is relatively easy to bump (one person to renegotiate
    // with); a tentative group meeting involves 4+ people's calendars.
    else if (ev.responseStatus === "tentative") {
      if ((ev.attendeeCount ?? 0) >= 3) {
        // Commitment:weak but hard enough that we push it into the
        // deep-stretch band — don't propose bumping 4+ people casually.
        ev_ = { score: 4, reason: "tentative group meeting", confidence: "low", summary: ev.summary, blockCost: "commitment", firmness: "strong" };
      } else {
        ev_ = { score: 3, reason: "tentative meeting", confidence: "low", summary: ev.summary, blockCost: "commitment", firmness: "weak" };
      }
    }
    // Recurring 1:1 = commitment:weak. The counterpart is someone the host
    // sees often; a one-off reschedule is a small ask.
    else if (ev.isRecurring && (ev.attendeeCount ?? 0) <= 2) {
      ev_ = { score: 3, reason: "recurring 1:1", confidence: "low", summary: ev.summary, blockCost: "commitment", firmness: "weak" };
    }
    // Confirmed group meeting (3+ attendees) = commitment:strong.
    else if ((ev.attendeeCount ?? 0) >= 3) {
      ev_ = { score: 5, reason: "confirmed group meeting", confidence: "high", summary: ev.summary, blockCost: "commitment", firmness: "strong" };
    }
    // Default confirmed meeting = commitment:strong. The host has to
    // renegotiate with the other party manually; Envoy never proposes it.
    else {
      ev_ = { score: 5, reason: "confirmed meeting", confidence: "high", summary: ev.summary, blockCost: "commitment", firmness: "strong" };
    }

    // Compiled priority bucket overrides — keyword-tagged events can be
    // bumped up to immovable, or softened if marked low-priority.
    for (const bucket of priorityBuckets) {
      const matches = bucket.keywords.some((kw) =>
        ev.summary.toLowerCase().includes(kw.toLowerCase())
      );
      if (matches) {
        if (bucket.level === "high") {
          ev_ = { score: 5, reason: "high priority", confidence: "high", summary: ev.summary, blockCost: "commitment", firmness: "strong" };
        } else if (bucket.level === "low" && ev_.score >= 3) {
          // Downgrade a protected slot to preference:weak (first-offer
          // tier). "This is flexible — you can schedule over it."
          ev_ = { score: 2, reason: "low priority (flexible)", confidence: "low", summary: ev.summary, blockCost: "preference", firmness: "weak" };
        }
        break;
      }
    }

    if (ev_.score > best.score) {
      best = ev_;
    }
  }

  // Determine kind: transparent context stays "open", everything else is "event".
  const kind: SlotKind = best.score <= 1 && best.reason !== "open" ? "open" : (best.score === 0 ? "open" : "event");

  return {
    ...base,
    score: best.score,
    confidence: best.confidence,
    reason: best.reason,
    eventSummary: best.summary,
    kind,
    blockCost: best.blockCost,
    firmness: best.firmness,
  };
}

/**
 * Hours-protection layer — applied after scoreSlot(), ONLY to slots that
 * come back open. Uses the intrinsic 2×2 model:
 *
 * Weekday off-hours = preference (host's own time), firmness graded by
 * distance from biz-hour edge:
 *   - 1h edge         → score 2, preference:weak  (first-offer)
 *   - 2-3h edge       → score 3, preference:strong (stretch 1)
 *   - 4h edge         → score 4, preference:strong (stretch 2)
 *   - 5+h edge        → score 5, preference:strong (sleep hours, never)
 *
 * Weekend = preference:strong, firmness graded by biz-equivalent vs edge:
 *   - biz-equivalent  → score 3 (stretch 1)
 *   - 1-2h edge       → score 4 (stretch 2)
 *   - 3+h edge        → score 5 (never)
 *
 * Real events sitting on top of these slots keep their own classification
 * (scoreSlot returned first, this layer doesn't touch events).
 */
function hoursProtectionLayer(
  hour: number,
  isWeekend: boolean,
  bizStart: number,
  bizEnd: number
): {
  score: number;
  reason: string;
  kind: SlotKind;
  blockCost: BlockCost;
  firmness: BlockFirmness;
} | null {
  if (isWeekend) {
    const inBizEquivalent = hour >= bizStart && hour < bizEnd;
    if (inBizEquivalent) {
      return { score: 3, reason: "weekend daytime", kind: "weekend", blockCost: "preference", firmness: "strong" };
    }
    // Weekend edge calculation: distance from nearest biz-equivalent edge.
    const edgeDistance = hour < bizStart ? bizStart - hour : hour - bizEnd + 1;
    if (edgeDistance <= 2) {
      return { score: 4, reason: "weekend edge", kind: "weekend", blockCost: "preference", firmness: "strong" };
    }
    return { score: 5, reason: "weekend off-hours (sleep)", kind: "weekend", blockCost: "preference", firmness: "strong" };
  }

  // Weekday within biz hours → no bump.
  if (hour >= bizStart && hour < bizEnd) return null;

  // Weekday outside biz hours. Distance from the nearest biz-hour edge
  // in whole hours; 0 means immediately adjacent (the 1h edge slot).
  const distance = hour < bizStart ? bizStart - hour - 1 : hour - bizEnd;
  if (distance <= 0) {
    // 1h edge — near-trivial accommodation.
    return { score: 2, reason: "just outside business hours", kind: "off_hours", blockCost: "preference", firmness: "weak" };
  }
  if (distance <= 2) {
    // 2-3h edge — meaningful ask.
    return { score: 3, reason: "off hours", kind: "off_hours", blockCost: "preference", firmness: "strong" };
  }
  if (distance <= 3) {
    // 4h edge — significant ask, deep stretch only.
    return { score: 4, reason: "early morning / late evening", kind: "off_hours", blockCost: "preference", firmness: "strong" };
  }
  // 5+h edge — sleep hours, never offered.
  return { score: 5, reason: "sleep hours", kind: "off_hours", blockCost: "preference", firmness: "strong" };
}

// --- Progressive offerability tiers (first-offer → stretch 1 → stretch 2) ---

/**
 * Which tier a slot falls into for a given link. The composer uses this to
 * emit separate prompt blocks (OFFERABLE SLOTS, STRETCH OPTIONS, DEEP STRETCH
 * OPTIONS) with different guardrails about when the LLM may reach into each.
 *
 * Rules:
 *   - `first-offer`: score ≤ 2 (preference:weak and open), OR score 3-4
 *     slots that fall within the host's explicit expansion window
 *     (preferredTimeStart/End + allowWeekends). These are shown in the
 *     widget and in the initial greeting.
 *   - `stretch1`: score 3 slots NOT in first-offer. VIP-only. Surfaced in
 *     conversation after the first round of guest pushback. Requires the
 *     LLM to offer with soft framing; holds are placed via [HOLD_SLOT].
 *   - `stretch2`: score 4 slots NOT in first-offer. VIP-only. Surfaced
 *     after a second round of guest pushback.
 *   - `null`: score 5, commitment:strong events, or a non-VIP link
 *     reaching score ≥ 3. Never offered.
 */
export type OfferTier = "first-offer" | "stretch1" | "stretch2" | null;

/**
 * Is this slot within the host's explicit preferredTimeStart/preferredTimeEnd
 * window on a weekday? Used by isFirstOffer to promote off-hours slots the
 * host has personally authorized ("I said 6 AM is fine for this link").
 */
function inExplicitWindow(slot: ScoredSlot, rules: LinkRules, tz: string): boolean {
  if (!rules.preferredTimeStart && !rules.preferredTimeEnd) return false;
  const { hour, minute } = getLocalParts(new Date(slot.start), tz);
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (rules.preferredTimeStart && timeStr < rules.preferredTimeStart) return false;
  if (rules.preferredTimeEnd && timeStr >= rules.preferredTimeEnd) return false;
  return true;
}

/**
 * Classify a slot into an offerability tier for a given link. This is the
 * single source of truth the composer uses to build the three prompt blocks.
 *
 * Never returns a tier for:
 *   - score 5 (immovable — real events, flights, blackouts, sleep hours)
 *   - commitment:strong slots (hard by definition)
 *   - stretches on a non-VIP link
 *
 * First-offer promotion via explicit expansion:
 *   - If the host set preferredTimeStart/End, score 3-4 off-hours slots
 *     inside that window become first-offer (the host pre-authorized).
 *   - If allowWeekends, weekend daytime (score 3) becomes first-offer.
 *   - The original slot score and blockCost are unchanged — only tier
 *     classification is affected.
 */
export function getTier(slot: ScoredSlot, rules: LinkRules, tz: string): OfferTier {
  // Host-explicit slot overrides (-1 preferred, -2 exclusive) are always
  // first-offer regardless of tier logic.
  if (slot.score < 0) return "first-offer";

  // Score 5: never offered.
  if (slot.score >= 5) return null;

  // Commitment:strong events are hard — even at score 4 they're not
  // reachable. The host must break them externally.
  if (slot.blockCost === "commitment" && slot.firmness === "strong") return null;

  // First-offer: the default safe tier.
  //   - Score ≤ 2: always first-offer (open, preference:weak, buffers,
  //     soft holds, 1h edge, tagged-soft blocked windows).
  //   - Score 3 within explicit preferredTime window: host authorized.
  //   - Score 3 weekend when allowWeekends: host authorized.
  //   - Score 4 within explicit preferredTime window: deeper pre-auth.
  if (slot.score <= 2) return "first-offer";
  if (slot.score <= 4 && inExplicitWindow(slot, rules, tz) && slot.kind === "off_hours") {
    return "first-offer";
  }
  if (slot.score <= 4 && slot.kind === "weekend" && rules.allowWeekends) {
    return "first-offer";
  }

  // Stretch bands exist only for VIP links.
  if (!rules.isVip) return null;

  // Stretch 1: score-3 slots not in first-offer. LLM-reachable after the
  // first round of guest pushback.
  if (slot.score === 3) return "stretch1";

  // Stretch 2: score-4 slots not in first-offer. LLM-reachable only after
  // a second round of guest pushback, and only on VIP links.
  if (slot.score === 4) return "stretch2";

  return null;
}

/** Convenience wrappers used throughout the composer + session route. */
export function isFirstOffer(slot: ScoredSlot, rules: LinkRules, tz: string): boolean {
  return getTier(slot, rules, tz) === "first-offer";
}
export function isStretch1(slot: ScoredSlot, rules: LinkRules, tz: string): boolean {
  return getTier(slot, rules, tz) === "stretch1";
}
export function isStretch2(slot: ScoredSlot, rules: LinkRules, tz: string): boolean {
  return getTier(slot, rules, tz) === "stretch2";
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

  // Generation envelope. Full outer window, all days. Each slot gets a
  // blockCost/firmness tag via scoreSlot + hoursProtectionLayer; the
  // composer reads those tags (not raw scores) via isFirstOffer/isStretch
  // to decide what to surface for each link. GEN_START/GEN_END cap the
  // outer edge — nothing earlier or later is ever scored, even for VIP
  // with explicit unlock. 5 AM is the absolute floor; before that is
  // sleep hours we never even generate.
  const GEN_START = 5;
  const GEN_END = 23; // 5 AM through 11 PM (last slot starts at 22:30)

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

    // Apply the hours-protection layer AFTER scoreSlot, ONLY to otherwise-
    // open slots. Real events, blackouts, and blocked windows keep their
    // existing classification — they're more specific than "it's a weekend".
    if (scored.kind === "open" && scored.blockCost === "none") {
      const layer = hoursProtectionLayer(hour, isWeekend, bizStart, bizEnd);
      if (layer) {
        scored.score = layer.score;
        scored.reason = layer.reason;
        scored.kind = layer.kind;
        scored.blockCost = layer.blockCost;
        scored.firmness = layer.firmness;
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
    // v3: intrinsic block-type scoring (blockCost + firmness), envelope
    //     extended to 5 AM, tentative groups bumped to score 4, buffers
    //     dropped to score 2, soft-tagged blocks at score 2, priority
    //     tiers collapsed to binary isVip.
    // v3.1: all-day event overlap uses date comparison instead of UTC time
    //       range — fixes timezone bleed (Wed event showing Tue+Wed in EDT).
    scheduleVersion: "v3.1",
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
  preferredTimeStart?: string; // "09:00" — widens the daily offering window
  preferredTimeEnd?: string; // "12:00"
  /** Inclusive date window in host's local calendar. "YYYY-MM-DD". */
  dateRange?: { start?: string; end?: string };
  slotOverrides?: SlotOverride[];
  /** @deprecated Use score -2 in slotOverrides instead. Kept for backward compat. */
  exclusiveSlots?: boolean;
  /**
   * VIP flag — binary. When true, Envoy runs the accommodative flows:
   * proactive expansion question at creation, progressive stretch tiers
   * during guest conversation, tentative-hold protection via the
   * [HOLD_SLOT] action. When false/unset, the link behaves normally —
   * first-offer only, no creative reach, no stretch.
   *
   * `isVip` alone does NOT auto-unlock any protected slots — it unlocks
   * Envoy's *access* to the stretch (score 3) and deep-stretch (score 4)
   * bands in her LLM prompt, but the actual opening of weekend / off-hours
   * slots for guest-facing offerings requires the explicit fields below.
   */
  isVip?: boolean;
  /**
   * Explicit host authorization to offer weekend slots for this link.
   * When true, weekend `preference:strong` slots within the weekend
   * biz-equivalent window become first-offer. When false/unset, weekends
   * are at most a VIP stretch option.
   */
  allowWeekends?: boolean;
  /**
   * Preferred meeting duration in minutes. The ideal length the host wants.
   * When set, `filterByDuration` requires enough consecutive slots to fit
   * this duration. If unset, defaults to 30.
   */
  duration?: number;
  /**
   * Minimum acceptable meeting duration in minutes. When set (and less than
   * `duration`), the host has agreed that a shorter meeting is OK if a full
   * `duration` window isn't available. `filterByDuration` uses this as the
   * hard floor — lone 30-min slots pass through when `minDuration` is 30.
   * The deal-room agent negotiates the final duration with the guest.
   */
  minDuration?: number;
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

  // isVip: coerce to strict boolean. Strings ("true"/"false") and other
  // truthy/falsy values are rejected to avoid parser LLMs emitting strings
  // by accident. Legacy `priority: "high"|"vip"` values are migrated to
  // isVip: true, and `priority: "normal"` (or anything else) is dropped.
  // NOTE: we explicitly DELETE non-boolean isVip to counter the spread
  // at the top of this function, which otherwise copies garbage through.
  if (typeof input.isVip === "boolean") {
    out.isVip = input.isVip;
  } else {
    delete out.isVip;
    if (input.priority === "vip" || input.priority === "high") {
      out.isVip = true;
    }
  }
  // priority is always dropped after possible migration — it's the legacy
  // field and shouldn't persist alongside isVip.
  delete out.priority;

  // allowWeekends: strict boolean. Non-boolean values get dropped even
  // though the top-level spread copied them through.
  if (typeof input.allowWeekends === "boolean") {
    out.allowWeekends = input.allowWeekends;
  } else {
    delete out.allowWeekends;
  }

  // duration / minDuration: must be positive integers. Drop non-numeric junk.
  if (typeof input.duration === "number" && input.duration > 0) {
    out.duration = Math.round(input.duration);
  } else {
    delete out.duration;
  }
  if (typeof input.minDuration === "number" && input.minDuration > 0) {
    out.minDuration = Math.round(input.minDuration);
  } else {
    delete out.minDuration;
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
    // Reset kind, blockCost, and firmness to open/none so the tier filter
    // treats host-explicit picks as always-offerable (getTier also
    // short-circuits on score < 0, but keeping the shape coherent helps
    // downstream UI and the dashboard heatmap).
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
        blockCost: "none" as const,
        firmness: undefined,
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

/**
 * Filter a slot list so that only slots with a sufficient consecutive run are
 * kept as valid start positions for a meeting.
 *
 * The scoring engine always generates 30-min granularity slots. If a meeting is
 * 60 min, a lone 30-min slot should never appear as an offerable start — the
 * meeting would bleed into a blocked slot.
 *
 * When `minDuration` is set (and < `durationMin`), the floor drops to
 * `minDuration` — the host has agreed a shorter meeting is acceptable when a
 * full window isn't available. Slots that satisfy `minDuration` but not
 * `durationMin` are marked with `isShortSlot: true` so the widget and LLM can
 * distinguish "fits full duration" from "fits minimum only".
 *
 * Pass-through when durationMin ≤ 30 (every 30-min slot is independently valid).
 */
export function filterByDuration(
  slots: ScoredSlot[],
  durationMin: number,
  minDuration?: number
): ScoredSlot[] {
  if (!durationMin || durationMin <= 30) return slots;
  const floor = (minDuration && minDuration < durationMin && minDuration > 0)
    ? minDuration
    : durationMin;
  const slotsNeededFull = Math.ceil(durationMin / 30);
  const slotsNeededMin = Math.ceil(floor / 30);
  const startSet = new Set(slots.map((s) => s.start));

  return slots
    .filter((slot) => {
      const t = new Date(slot.start).getTime();
      // Must satisfy at least the minimum floor
      for (let i = 1; i < slotsNeededMin; i++) {
        const nextStart = new Date(t + i * 30 * 60 * 1000).toISOString();
        if (!startSet.has(nextStart)) return false;
      }
      return true;
    })
    .map((slot) => {
      if (floor < durationMin) {
        // Check if it also satisfies the full preferred duration
        const t = new Date(slot.start).getTime();
        let fitsFull = true;
        for (let i = 1; i < slotsNeededFull; i++) {
          const nextStart = new Date(t + i * 30 * 60 * 1000).toISOString();
          if (!startSet.has(nextStart)) { fitsFull = false; break; }
        }
        if (!fitsFull) {
          return { ...slot, isShortSlot: true };
        }
      }
      return slot;
    });
}
