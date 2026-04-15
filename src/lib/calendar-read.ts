/**
 * Calendar Read — LLM-generated synthesis of a user's calendar.
 *
 * Two surfaces use this module:
 *   1. Onboarding intro paragraph — one fun riff after they connect Google
 *   2. Dashboard "Today's Insight" — a one-liner refreshed once per day
 *
 * Both share the same digest pipeline:
 *   - Pull recent + upcoming events via getCachedCalendarContext
 *   - Redact sensitive summaries BEFORE the LLM sees them (legal/medical/etc.)
 *   - Format as compact one-line entries
 *   - Hand to Claude Haiku with a tight prompt, low token budget
 *
 * Both return null on empty/disconnected calendar so callers can skip
 * gracefully. LLM errors also return null — never block the caller.
 */
import { generateText } from "ai";
import { envoyModel } from "./model";
import { getCachedCalendarContext, type CalendarEvent } from "./calendar";

// ── Redaction ────────────────────────────────────────────────────────────
//
// Before sending event summaries to the LLM, drop anything that looks
// legally privileged, medical, therapeutic, or otherwise sensitive.
// Erring on the side of over-redaction — a missed event is fine, a leaked
// one is not. The LLM cannot joke about what it cannot see.
const SENSITIVE_PATTERNS = [
  /\bprivileged\b/i,
  /\bconfidential\b/i,
  /\bhipaa\b/i,
  /\btherapy\b/i,
  /\btherapist\b/i,
  /\bpsychiatr/i,
  /\bmedical\b/i,
  /\bdoctor\b/i,
  /\bdentist\b/i,
  /\bdental\b/i,
  /\bclinic\b/i,
  /\bpap\b/i,
  /\bsmear\b/i,
  /\bvasect/i,
  /\bcolonosc/i,
  /\bmammo/i,
  /\bbiops/i,
  /\brehab\b/i,
  /\bsponsor\b/i,
  /\bhiv\b/i,
  /\bstd\b/i,
  /\bshingles\b/i,
  /\bvaccine\b/i,
  /\bmeds\b/i,
  /\bpharmac/i,
  /\bprescription\b/i,
  /\bhearing\b/i,
  /\bdeposition\b/i,
  /\bsettlement\b/i,
  /\bdivorce\b/i,
  /\bcustody\b/i,
  /\battorney\b/i,
  /\blawsuit\b/i,
  /\btestimony\b/i,
  /\bmatter:/i, // common legal prefix ("X Matter: prep")
  /\bmental health\b/i,
  /\bcounsel(l)?ing\b/i,
];

function isSensitive(summary: string | undefined): boolean {
  if (!summary) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(summary));
}

// ── Digest ───────────────────────────────────────────────────────────────
//
// Turns raw CalendarEvent[] into compact text lines the LLM can chew on.
// Each line carries: when, calendar label, summary, and soft signals
// (attendee count, all-day, recurring). Keeps it under ~120 chars per line.
function formatEventLine(ev: CalendarEvent, tz: string): string {
  if (ev.isAllDay) {
    const d = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      weekday: "short",
    }).format(ev.start);
    const days = Math.max(
      1,
      Math.round((ev.end.getTime() - ev.start.getTime()) / 86_400_000)
    );
    const span = days > 1 ? ` (${days}d)` : "";
    return `${d}${span} ALLDAY [${ev.calendar}] ${ev.summary}`;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(ev.start);
  const parts = [fmt, `[${ev.calendar}]`, ev.summary];
  if (ev.attendeeCount && ev.attendeeCount > 1) parts.push(`(${ev.attendeeCount} people)`);
  if (ev.isRecurring) parts.push("↻");
  return parts.join(" ");
}

export interface CalendarDigest {
  totalEvents: number;
  calendarCount: number;
  calendarNames: string[];
  eventLines: string[];
  redactedCount: number;
}

/**
 * Build a digest of the user's calendar for LLM consumption.
 * Returns null when disconnected or empty — caller should skip.
 *
 * Window: `backDays` before today through `forwardDays` after.
 * Events are redacted via SENSITIVE_PATTERNS before making the digest.
 */
export async function buildCalendarDigest(
  userId: string,
  timezone: string,
  opts: { backDays?: number; forwardDays?: number; maxEvents?: number } = {}
): Promise<CalendarDigest | null> {
  const { backDays = 3, forwardDays = 21, maxEvents = 80 } = opts;

  const ctx = await getCachedCalendarContext(userId, timezone);
  if (!ctx.connected || ctx.events.length === 0) return null;

  const now = new Date();
  const earliest = new Date(now.getTime() - backDays * 86_400_000);
  const latest = new Date(now.getTime() + forwardDays * 86_400_000);

  let redactedCount = 0;
  const windowed = ctx.events.filter((ev) => {
    if (ev.start > latest || ev.end < earliest) return false;
    if (isSensitive(ev.summary)) {
      redactedCount += 1;
      return false;
    }
    return true;
  });

  // Prefer events with attendees / meetings over transparent/all-day noise,
  // then trim to maxEvents while preserving chronological order.
  const ranked = [...windowed].sort((a, b) => {
    const aScore = (a.attendeeCount ?? 0) + (a.isAllDay ? 0 : 1);
    const bScore = (b.attendeeCount ?? 0) + (b.isAllDay ? 0 : 1);
    return bScore - aScore;
  });
  const kept = ranked.slice(0, maxEvents);
  kept.sort((a, b) => a.start.getTime() - b.start.getTime());

  return {
    totalEvents: ctx.events.length,
    calendarCount: ctx.calendars.length,
    calendarNames: ctx.calendars,
    eventLines: kept.map((ev) => formatEventLine(ev, timezone)),
    redactedCount,
  };
}

// ── LLM generators ──────────────────────────────────────────────────────

const MODEL_ID = "claude-haiku-4-5-20251001";

/**
 * Generates the short wow paragraph shown at the very top of onboarding.
 * ~3-5 sentences, warm/playful, grounded in real calendar specifics.
 * Returns null on empty calendar or LLM error (caller should skip).
 */
export async function generateOnboardingCalendarRead(
  userId: string,
  timezone: string,
  userName?: string
): Promise<string | null> {
  try {
    const digest = await buildCalendarDigest(userId, timezone, {
      backDays: 2,
      forwardDays: 21,
      maxEvents: 70,
    });
    if (!digest || digest.eventLines.length === 0) return null;

    const firstName = (userName || "").split(" ")[0] || "there";
    const system = `You are Envoy, an AI scheduling assistant meeting a new user for the first time. You've just been given access to their calendar and you want to open with a small moment of "wow, you actually looked." Write ONE short paragraph (3–5 sentences, max ~90 words) that riffs on concrete details from their upcoming calendar. Be warm, observant, a little playful — like a smart friend who just peeked at their week and has a reaction.

Rules:
- Reference SPECIFIC details from the events (names, event titles, calendar labels, places). Specificity is the whole point.
- Never invent details. Only use what's in the event list.
- Don't list things robotically. Make it feel like a read, not a report.
- Don't mention the number of calendars unless it's genuinely unusual (5+).
- Don't comment on health, legal, or family-sensitive topics — those events have already been filtered out, but stay clear of the topic.
- Don't explain yourself or describe what you're doing. No "I noticed that..." or "Looking at your calendar...". Just make the observation.
- End on a warm forward-looking note, not a to-do list.
- Plain text. No markdown, no bullet points, no headers.`;

    const user = `The user's name is ${firstName}. They are in timezone ${timezone}. Here are their upcoming calendar events (one per line):

${digest.eventLines.join("\n")}

Write the one-paragraph read now.`;

    const { text } = await generateText({
      model: envoyModel(MODEL_ID),
      system,
      prompt: user,
      temperature: 0.9,
    });
    const trimmed = text.trim();
    return trimmed || null;
  } catch (err) {
    console.error("[generateOnboardingCalendarRead] failed:", err);
    return null;
  }
}

/**
 * Generates a single-sentence "today's insight" for the dashboard.
 * Regenerated once per day; cached in preferences.explicit.dailyInsight.
 */
export async function generateDailyInsight(
  userId: string,
  timezone: string
): Promise<string | null> {
  try {
    const digest = await buildCalendarDigest(userId, timezone, {
      backDays: 1,
      forwardDays: 10,
      maxEvents: 60,
    });
    if (!digest || digest.eventLines.length === 0) return null;

    const today = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date());

    const system = `You are Envoy. Write ONE sentence (max ~25 words) of playful observation about the user's day or week based on their calendar. It should feel like a smart friend glancing at their schedule and saying something true and a little fun.

Rules:
- Ground it in a specific, real detail from the events below. No generic "you have a busy day ahead" filler.
- Don't invent anything. Only use what's on the list.
- Don't mention health, legal, or family-sensitive topics.
- No "I see that" / "Looking at" / "Your calendar shows" framings. Just say the thing.
- No markdown, no emoji.
- Today is ${today}.`;

    const user = `Upcoming events (timezone ${timezone}):

${digest.eventLines.join("\n")}

Write the one-sentence insight now.`;

    const { text } = await generateText({
      model: envoyModel(MODEL_ID),
      system,
      prompt: user,
      temperature: 0.95,
    });
    // Guard against multi-sentence drift — keep only the first sentence.
    const trimmed = text.trim().split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
    return trimmed || null;
  } catch (err) {
    console.error("[generateDailyInsight] failed:", err);
    return null;
  }
}
