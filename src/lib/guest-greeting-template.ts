/**
 * Deterministic guest-side greeting template.
 *
 * Fires once per session when a logged-in guest visits a deal room for the
 * first time. Matches the host-side template pattern per SPEC — no LLM on
 * cold-page render. Slot selection and preference-pattern citation come from
 * structured data, not natural language generation.
 *
 * Template:
 *   "Hey {guestFirstName} — jumping in for you. **{slotLabel}** looks like
 *    a clean overlap{, aligns with your {prefPattern}} and it's
 *    {hostFirstName}'s best slot too. Want me to lock it in?"
 *
 * All optional clauses degrade gracefully when the data isn't there.
 */

import type { ScoredSlot } from "@/lib/scoring";
import { shortTimezoneLabel } from "./timezone";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GuestPreferencesSummary {
  /** "video" | "phone" | "in-person" — from User.preferences.explicit.format */
  format?: string | null;
  /** Free-text time-of-day preference — e.g. "mornings", "afternoons". */
  preferredTimesText?: string | null;
}

export interface BuildGuestGreetingInput {
  guestFirstName: string | null;
  hostFirstName: string;
  /** Already-filtered, ordered offerable slots (score ≤ 1). Earliest first. */
  offerableSlots: ScoredSlot[];
  guestPreferences: GuestPreferencesSummary;
  /** Guest's IANA timezone if known. */
  guestTimezone: string | null;
  /** Host's IANA timezone. Always present. */
  hostTimezone: string;
  /** Current time — parameterized for testability. */
  now?: Date;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the deterministic guest-side greeting, or null if nothing useful to
 * say (e.g. no offerable slots). The caller should skip posting the message
 * when this returns null.
 */
export function buildGuestGreeting(input: BuildGuestGreetingInput): string | null {
  const now = input.now ?? new Date();
  const topSlots = pickTopSlots(input.offerableSlots, now, 3);
  if (topSlots.length === 0) return null;

  const slotLabels = topSlots.map((s) =>
    formatSlotLabel(new Date(s.start), input.hostTimezone, input.guestTimezone, now),
  );
  const slotsPhrase = formatSlotList(slotLabels);

  const prefPattern = formatPreferencePattern(input.guestPreferences);
  const hello = input.guestFirstName ? `Hey ${input.guestFirstName}` : "Hey";

  if (topSlots.length === 1) {
    const prefClause = prefPattern ? `, aligns with your ${prefPattern},` : "";
    const hostClause = input.hostFirstName
      ? ` and it's ${input.hostFirstName}'s best slot too`
      : "";
    return `${hello} — jumping in for you. ${slotsPhrase} looks like a clean overlap${prefClause}${hostClause}. Want me to lock it in?`;
  }

  const prefClause = prefPattern ? ` (aligns with your ${prefPattern})` : "";
  const hostClause = input.hostFirstName
    ? ` ${slotLabels[0].includes("·") ? "The first" : "Top one"} is ${input.hostFirstName}'s best slot.`
    : "";
  return `${hello} — jumping in for you. A few clean overlaps: ${slotsPhrase}${prefClause}.${hostClause} Want me to lock one in?`;
}

/** Format a list of slot labels as bold-wrapped, comma-separated phrase. */
function formatSlotList(labels: string[]): string {
  const bold = labels.map((l) => `**${l}**`);
  if (bold.length === 1) return bold[0];
  if (bold.length === 2) return `${bold[0]} or ${bold[1]}`;
  return `${bold.slice(0, -1).join(", ")}, or ${bold[bold.length - 1]}`;
}

// ─── Slot picker ─────────────────────────────────────────────────────────────

/**
 * Pick the top candidate from an offerable list. Prefers host-preferred slots
 * (score ≤ -1), falls back to the earliest offerable. Ignores past slots.
 */
export function pickTopSlot(slots: ScoredSlot[], now: Date): ScoredSlot | null {
  return pickTopSlots(slots, now, 1)[0] ?? null;
}

/**
 * Pick up to N candidates from an offerable list. Same ranking rule as
 * pickTopSlot — preferred (lower score) first, ties broken by earliest start.
 */
export function pickTopSlots(slots: ScoredSlot[], now: Date, n: number): ScoredSlot[] {
  const future = slots.filter((s) => new Date(s.start) > now && s.score <= 1);
  if (future.length === 0) return [];
  const sorted = [...future].sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });
  return sorted.slice(0, n);
}

// ─── Slot label formatter ────────────────────────────────────────────────────

/**
 * Format a datetime as a slot label. Dual-TZ ("Tue Apr 21 · 1:00 PM ET (10 AM PT)")
 * when host and guest timezones differ; single-TZ otherwise. Times are pre-formatted
 * in code via Intl — the template never asks an LLM to compute day-of-week, offsets,
 * or conversions.
 */
export function formatSlotLabel(
  start: Date,
  hostTimezone: string,
  guestTimezone: string | null,
  now: Date,
): string {
  const dualTz = !!guestTimezone && guestTimezone !== hostTimezone;
  const primaryTz = dualTz ? guestTimezone! : hostTimezone;

  const dayLabel = start.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: primaryTz,
  });
  const primaryTime = formatTimeShort(start, primaryTz);
  const primaryLabel = `${dayLabel} · ${primaryTime} ${shortTimezoneLabel(primaryTz, now)}`;

  if (!dualTz) return primaryLabel;

  const hostTime = formatTimeShort(start, hostTimezone);
  return `${primaryLabel} (${hostTime} ${shortTimezoneLabel(hostTimezone, now)})`;
}

/** "1:00 PM" — :00 retained for parity with guest-greeting voice. */
function formatTimeShort(d: Date, timezone: string): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
}

// ─── Preference pattern ──────────────────────────────────────────────────────

/**
 * Render a short human phrase describing the guest's scheduling preferences,
 * or null if there's nothing concrete to cite. Stays factual — never invents.
 */
export function formatPreferencePattern(
  prefs: GuestPreferencesSummary,
): string | null {
  const parts: string[] = [];

  const timesText = (prefs.preferredTimesText || "").toString().toLowerCase();
  if (/\bmorning/i.test(timesText)) parts.push("mornings");
  else if (/\bafternoon/i.test(timesText)) parts.push("afternoons");
  else if (/\bevening/i.test(timesText)) parts.push("evenings");

  if (prefs.format === "video") parts.push("video");
  else if (prefs.format === "phone") parts.push("phone");
  else if (prefs.format === "in-person") parts.push("in-person");

  if (parts.length === 0) return null;
  if (parts.length === 1) return `${parts[0]} preference`;
  if (parts.length === 2) return `"${parts.join(" + ")}" preference`;
  return `"${parts.slice(0, -1).join(", ")} + ${parts[parts.length - 1]}" preference`;
}

// ─── Preference summary extractor ────────────────────────────────────────────

/**
 * Pull a minimal preference summary from a User.preferences JSON blob.
 * Narrow + tolerant — missing or malformed fields silently omit.
 */
export function extractGuestPreferencesSummary(
  preferences: unknown,
): GuestPreferencesSummary {
  if (!preferences || typeof preferences !== "object") return {};
  const prefs = preferences as Record<string, unknown>;
  const explicit = (prefs.explicit as Record<string, unknown>) || {};

  const format = typeof explicit.format === "string" ? explicit.format : null;

  // preferredTimes may be a string (free text) or structured JSON. For the
  // pattern cite we only need a string; if it's an object, stringify a
  // plausible natural-language form ("mornings" / "afternoons").
  let preferredTimesText: string | null = null;
  const pt = explicit.preferredTimes;
  if (typeof pt === "string") {
    preferredTimesText = pt;
  } else if (pt && typeof pt === "object") {
    const s = JSON.stringify(pt).toLowerCase();
    if (s.includes("morning")) preferredTimesText = "mornings";
    else if (s.includes("afternoon")) preferredTimesText = "afternoons";
    else if (s.includes("evening")) preferredTimesText = "evenings";
  }

  return {
    format,
    preferredTimesText,
  };
}
