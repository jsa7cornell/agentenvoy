/**
 * Activity vocabulary — single source of truth.
 *
 * Decided in proposal 2026-04-28_event-edit-handler-and-composer (Q3 fold).
 *
 * Replaces five scattered sites that previously duplicated activity-related
 * vocab in slightly different formats:
 *  - GENERIC_TOPICS in actions.ts:33-43
 *  - GENERIC_TOPICS in api/negotiate/session/route.ts:51-58 (drift bug)
 *  - regex chain in deal-room.tsx getMeetingEmoji (1235-1251)
 *  - canonical emoji set comment in deal-room.tsx:1224-1234
 *  - inline activity table in calendar-event-composer.md:141, 142, 156-157
 *
 * Adding a new activity should mean editing this file ONLY. The composer
 * playbook is build-time substituted from ACTIVITY_VOCAB via
 * playbooks/index.ts; runtime sites import their helpers from here.
 *
 * SPEC §2.2 (Activity vocab term) and §3.6 (Event title generation) point
 * here as canonical.
 */

export interface ActivityEntry {
  /** Canonical lowercase phrase. Stored as-is in link.parameters.activity. */
  name: string;
  /** Aliases the LLM might emit; matched case-insensitively. */
  aliases: readonly string[];
  /** Display emoji. Used by emoji picker and calendar invite copy. */
  emoji: string;
  /**
   * Default format when activity is named alone. Drives the physical-activity
   * rule in calendar-event-composer.md — "video" silently applying to a bike
   * ride was the bug this primitive prevents.
   */
  defaultFormat: "in-person" | "video" | "phone";
  /**
   * Natural-window heuristic for the §3.D proactive widening prompt.
   * null = no widening prompt fires (e.g. neutral activities like "intro").
   * Times are HH:MM in host-local TZ (interpreted at write time).
   */
  naturalWindow: { start: string; end: string } | null;
}

export const ACTIVITY_VOCAB: readonly ActivityEntry[] = [
  { name: "coffee",     aliases: ["coffee", "cafe", "café"],                            emoji: "☕",  defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "10:00" } },
  { name: "breakfast",  aliases: ["breakfast"],                                         emoji: "🍳", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "09:00" } },
  { name: "lunch",      aliases: ["lunch", "brunch"],                                   emoji: "🍽️", defaultFormat: "in-person", naturalWindow: { start: "11:30", end: "14:00" } },
  { name: "dinner",     aliases: ["dinner"],                                            emoji: "🍽️", defaultFormat: "in-person", naturalWindow: { start: "18:00", end: "21:00" } },
  { name: "drinks",     aliases: ["drinks", "cocktails", "happy hour"],                 emoji: "🍻", defaultFormat: "in-person", naturalWindow: { start: "17:00", end: "21:00" } },
  { name: "bike ride",  aliases: ["bike ride", "bike", "biking", "cycling", "cycle"],   emoji: "🚴", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" } },
  { name: "hike",       aliases: ["hike", "hiking", "trail"],                           emoji: "🥾", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "17:00" } },
  { name: "run",        aliases: ["run", "running", "jog", "jogging", "trail run"],     emoji: "🏃", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" } },
  { name: "walk",       aliases: ["walk", "walking"],                                   emoji: "🚶", defaultFormat: "in-person", naturalWindow: { start: "11:00", end: "20:00" } },
  { name: "surf",       aliases: ["surf", "surfing"],                                   emoji: "🏄", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "18:00" } },
  { name: "yoga",       aliases: ["yoga"],                                              emoji: "🧘", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" } },
  { name: "workout",    aliases: ["workout", "gym", "training", "lift"],                emoji: "🏋️", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" } },
  { name: "swim",       aliases: ["swim", "swimming"],                                  emoji: "🏊", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" } },
  { name: "brainstorm", aliases: ["brainstorm", "brainstorming"],                       emoji: "🧠", defaultFormat: "video",     naturalWindow: null },
  { name: "intro",      aliases: ["intro", "introduction", "meet-and-greet"],           emoji: "👋", defaultFormat: "video",     naturalWindow: null },
  { name: "interview",  aliases: ["interview"],                                         emoji: "🎤", defaultFormat: "video",     naturalWindow: null },
] as const;

/**
 * Generic phrases that should NOT become a topic. The LLM emits these as
 * filler when no real topic was given; we filter to null at write time so
 * `getEventTitle()` falls through to format/name templates.
 *
 * Distinct from ACTIVITY_VOCAB — these aren't activities, they're filler.
 */
export const GENERIC_TOPICS: ReadonlySet<string> = new Set([
  "meeting", "catch up", "catch-up", "catchup", "chat", "sync",
  "check in", "check-in", "checkin", "connect", "touch base",
  "quick chat", "quick meeting", "quick sync", "discussion",
  "call", "quick call", "phone call", "video call",
  "zoom", "zoom call", "video", "talk",
]);

/** True when `topic` is one of the generic filler words. Case-insensitive, trims whitespace. */
export function isGenericTopic(topic: string | null | undefined): boolean {
  if (!topic) return false;
  return GENERIC_TOPICS.has(topic.trim().toLowerCase());
}

/**
 * Look up a vocab entry by canonical name OR alias. Case-insensitive,
 * trims whitespace. Returns null when input is empty or unknown.
 *
 * Used by:
 *  - actions.ts to determine `topicSource` at create time (vocab match → "activity")
 *  - actions.ts B.1 defense-in-depth on backfill misses
 *  - deal-room.tsx getMeetingEmoji to derive emoji from activity field
 */
export function findActivity(input: string | null | undefined): ActivityEntry | null {
  if (!input) return null;
  const needle = input.trim().toLowerCase();
  if (!needle) return null;
  for (const entry of ACTIVITY_VOCAB) {
    if (entry.name === needle) return entry;
    for (const alias of entry.aliases) {
      if (alias === needle) return entry;
    }
  }
  return null;
}

/** Emoji for a given activity name/alias. Null if not in vocab. */
export function emojiForActivity(activity: string | null | undefined): string | null {
  return findActivity(activity)?.emoji ?? null;
}

/** Default format for a given activity. Null if not in vocab. */
export function defaultFormatForActivity(
  activity: string | null | undefined,
): ActivityEntry["defaultFormat"] | null {
  return findActivity(activity)?.defaultFormat ?? null;
}

/** Natural window for the proactive-widening prompt. Null if not in vocab or activity has no natural window. */
export function naturalWindowForActivity(
  activity: string | null | undefined,
): { start: string; end: string } | null {
  return findActivity(activity)?.naturalWindow ?? null;
}

/**
 * Render the canonical activity table as a markdown block for build-time
 * substitution into calendar-event-composer.md. Used by playbooks/index.ts
 * when serving the composer prompt — placeholder `{{ACTIVITY_VOCAB_TABLE}}`
 * in the .md file gets replaced with the output of this function.
 *
 * Two formats are emitted:
 *  - emoji line (for the §"Set activity + activityIcon" rule)
 *  - natural-window table (for §"Proactive widening" heuristic)
 *
 * Keep this rendering deterministic — playbook hash stability matters for
 * eval reproducibility.
 */
export function renderActivityVocabMarkdown(): string {
  const emojiLine = ACTIVITY_VOCAB.map((e) => `${e.emoji} ${e.name}`).join(", ");
  return `Canonical activity vocabulary (single source of truth — \`app/src/lib/activity-vocab.ts\`):\n\n${emojiLine}.`;
}

/** Render only the activities that have a natural window — for the §3.D widening heuristic. */
export function renderNaturalWindowsMarkdown(): string {
  const rows = ACTIVITY_VOCAB
    .filter((e) => e.naturalWindow !== null)
    .map((e) => {
      const w = e.naturalWindow!;
      return `| ${e.emoji} ${e.name} | ${w.start}–${w.end} |`;
    })
    .join("\n");
  return `| Activity | Natural window (host-local TZ) |\n|---|---|\n${rows}`;
}
