/**
 * Activity vocabulary — single source of truth.
 *
 * Decided in proposal 2026-04-28_event-edit-handler-and-composer (Q3 fold).
 * Extended 2026-05-12 (event-data-model-google-aligned-and-meeting-tip
 * proposal, decided 2026-05-12): 16 → 20 entries, adds `meet`, `call`, `chat`,
 * `other`; renames `bike ride` → `bike-ride` (kebab-case); coffee 30m → 45m.
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
 * runtime-prompts/index.ts; runtime sites import their helpers from here.
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
   * 2026-05-14 cmp4u* video-call emoji bug: optional format-aware emoji
   * override. When the host's chosen format matches a key here, the override
   * wins over the static `emoji` field above. Today only `call` uses this
   * (📞 for phone, 📹 for video); other entries either lock format (so static
   * emoji is correct by definition) or use format-agnostic emoji that work
   * across formats (💬 chat, 🧠 brainstorm, 👋 intro, etc.).
   *
   * Format-locked entries (defaultFormat: "in-person" / "phone" / "video")
   * generally don't need this — their emoji matches the locked format.
   * Format-flex entries (defaultFormat: null) only need it when the static
   * emoji is strongly format-coded.
   */
  emojiByFormat?: Partial<Record<"in-person" | "video" | "phone", string>>;
  /**
   * 2026-05-14 cmp4u* video-call title bug: optional format-aware title-
   * prefix override consumed by `buildEventTitle`. When the host's chosen
   * format matches a key here, the override wins over the title-cased
   * canonical name. Today only `call` uses this ("Call" for phone, "VC" for
   * video) — the static title-case of `call` is "Call", which is wrong for
   * a video call. Without this override, `buildEventTitle` would produce
   * "Call: Calle + John" for a video meeting because the vocab lookup wins
   * before the format-prefix fallback (FORMAT_PREFIX_MAP at
   * build-event-title.ts:53).
   */
  prefixByFormat?: Partial<Record<"in-person" | "video" | "phone", string>>;
  /**
   * Default format when activity is named alone. Drives the physical-activity
   * rule in calendar-event-composer.md — "video" silently applying to a bike
   * ride was the bug this primitive prevents.
   *
   * 2026-05-12: extended to allow `null` for format-flex activities (meet,
   * chat, intro, brainstorm, interview, other). When null, format resolves
   * from link prefs → host prefs → system default per the cascade.
   *
   * Field name preserved (not renamed to `formatLock`) — reviewer N2 rejected
   * the "lock" framing because host-emitted format still overrides
   * ("remote coffee chat over phone" stays a valid combo).
   */
  defaultFormat: "in-person" | "video" | "phone" | null;
  /**
   * Natural-window heuristic for the §3.D proactive widening prompt.
   * null = no widening prompt fires (e.g. neutral activities like "intro").
   * Times are HH:MM in host-local TZ (interpreted at write time).
   */
  naturalWindow: { start: string; end: string } | null;
  /**
   * Sensible default meeting length in minutes when the host names this
   * activity but doesn't specify a duration. Read by `handleCreateLink`
   * before falling through to the global 30-min default. Solves the
   * "set up a run with John — 30 min" problem (a run is naturally an
   * hour, not half an hour). null = no override; downstream falls back
   * to the global default.
   */
  defaultDuration: number | null;
}

export const ACTIVITY_VOCAB: readonly ActivityEntry[] = [
  // ── Physical / social activities (format-locked: in-person) ──
  { name: "coffee",     aliases: ["coffee", "cafe", "café"],                            emoji: "☕",  defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "10:00" }, defaultDuration: 45 },
  { name: "breakfast",  aliases: ["breakfast"],                                         emoji: "🍳", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "09:00" }, defaultDuration: 60 },
  { name: "lunch",      aliases: ["lunch", "brunch", "grab a bite"],                    emoji: "🍽️", defaultFormat: "in-person", naturalWindow: { start: "11:30", end: "14:00" }, defaultDuration: 60 },
  { name: "dinner",     aliases: ["dinner"],                                            emoji: "🍽️", defaultFormat: "in-person", naturalWindow: { start: "18:00", end: "21:00" }, defaultDuration: 90 },
  { name: "drinks",     aliases: ["drinks", "cocktails", "happy hour"],                 emoji: "🍻", defaultFormat: "in-person", naturalWindow: { start: "17:00", end: "21:00" }, defaultDuration: 90 },
  { name: "bike-ride",  aliases: ["bike ride", "bike-ride", "bike", "biking", "cycling", "cycle"], emoji: "🚴", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" }, defaultDuration: 60 },
  { name: "hike",       aliases: ["hike", "hiking", "trail"],                           emoji: "🥾", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "17:00" }, defaultDuration: 120 },
  { name: "run",        aliases: ["run", "running", "jog", "jogging", "trail run"],     emoji: "🏃", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" }, defaultDuration: 45 },
  { name: "walk",       aliases: ["walk", "walking"],                                   emoji: "🚶", defaultFormat: "in-person", naturalWindow: { start: "11:00", end: "20:00" }, defaultDuration: 30 },
  { name: "surf",       aliases: ["surf", "surfing"],                                   emoji: "🏄", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "18:00" }, defaultDuration: 90 },
  { name: "yoga",       aliases: ["yoga"],                                              emoji: "🧘", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" }, defaultDuration: 60 },
  { name: "workout",    aliases: ["workout", "gym", "training", "lift"],                emoji: "🏋️", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" }, defaultDuration: 60 },
  { name: "swim",       aliases: ["swim", "swimming"],                                  emoji: "🏊", defaultFormat: "in-person", naturalWindow: { start: "07:00", end: "20:00" }, defaultDuration: 45 },

  // ── Work/professional activities (format-flex: null defaultFormat) ──
  // 2026-05-12 additions. These don't lock format — coffee call vs. coffee
  // in-person is a real distinction, and "meet" / "chat" can be any medium.
  { name: "meet",       aliases: ["meet", "meet up", "meet-up", "get together", "hang", "1:1", "one on one", "review", "catch up in person"], emoji: "🤝", defaultFormat: null, naturalWindow: null, defaultDuration: null },
  // 2026-05-14 cmp4u*: "call" is format-flex now. Modern usage ("let's hop
  // on a call", "VC with Calle") is video-default; "ring", "give me a buzz"
  // are still phone shapes. Format-aware emoji + prefix overrides resolve
  // the right display per host-chosen format. defaultFormat is null so the
  // host's format wins (no silent phone-locking like the prior entry).
  { name: "call",       aliases: ["call", "phone call", "video call", "vc", "zoom call", "zoom", "ring", "give me a buzz"], emoji: "📞", emojiByFormat: { video: "📹", phone: "📞", "in-person": "🤝" }, prefixByFormat: { video: "VC", phone: "Call", "in-person": "Meeting" }, defaultFormat: null, naturalWindow: null, defaultDuration: null },
  { name: "chat",       aliases: ["chat", "catch up", "quick chat"],                    emoji: "💬", defaultFormat: null, naturalWindow: null, defaultDuration: null },
  { name: "brainstorm", aliases: ["brainstorm", "brainstorming"],                       emoji: "🧠", defaultFormat: null,    naturalWindow: null, defaultDuration: null },
  { name: "intro",      aliases: ["intro", "introduction", "meet-and-greet"],           emoji: "👋", defaultFormat: null,    naturalWindow: null, defaultDuration: null },
  { name: "interview",  aliases: ["interview"],                                         emoji: "🎤", defaultFormat: null,    naturalWindow: null, defaultDuration: null },

  // ── Catchall ──
  { name: "other",      aliases: ["other"],                                             emoji: "📌", defaultFormat: null, naturalWindow: null, defaultDuration: null },
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
  // Scheduling directive verbs — the model sometimes emits these literally
  // when the host uses them as a directive ("grab 45 with drake" = "please
  // schedule a 45-min meeting with Drake"). "grab" is the action, not the
  // activity. Null them so the title falls back to the "{invitee} + {host}"
  // template rather than the verb becoming the card title.
  // (cmp5ysc8r — "grab" rerouted to customTitle instead of nulled)
  "grab", "grab time", "link up", "hang out", "hangout", "catch up with", "touch base with",
]);

/**
 * Look up a canonical activity entry by name or alias.
 * Case-insensitive. Returns the canonical entry, or null when no match.
 */
export function findActivity(query: string | null | undefined): ActivityEntry | null {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  for (const entry of ACTIVITY_VOCAB) {
    if (entry.name === q) return entry;
    if (entry.aliases.some((a) => a.toLowerCase() === q)) return entry;
  }
  return null;
}

/**
 * Emoji for an activity phrase. Returns null when the phrase isn't in the
 * vocab — caller may fall back to a format-derived emoji or omit the icon
 * entirely. Original null-fallback semantics preserved (callers handle the
 * miss explicitly; do not force a 📌 default).
 *
 * 2026-05-14 cmp4u*: optional `format` parameter routes through the entry's
 * `emojiByFormat` override when the entry defines one for the given format.
 * Only `call` uses this today (📹 video, 📞 phone, 🤝 in-person). Callers
 * that don't know the format can omit the param — falls back to the entry's
 * static `emoji`, preserving pre-fix behavior.
 */
export function emojiForActivity(
  activity: string | null | undefined,
  format?: "in-person" | "video" | "phone" | null,
): string | null {
  const entry = findActivity(activity);
  if (!entry) return null;
  if (format && entry.emojiByFormat?.[format]) {
    return entry.emojiByFormat[format];
  }
  return entry.emoji;
}

/**
 * Default duration in minutes for an activity. Returns null when the activity
 * is format-flex (the caller should fall through to link prefs → host prefs →
 * system default).
 */
export function defaultDurationForActivity(activity: string | null | undefined): number | null {
  const entry = findActivity(activity);
  return entry?.defaultDuration ?? null;
}

/**
 * Default format for an activity. Returns null for format-flex activities
 * (meet, chat, intro, brainstorm, interview, other). Caller falls through to
 * link prefs → host prefs → system default when null.
 */
export function defaultFormatForActivity(
  activity: string | null | undefined,
): "in-person" | "video" | "phone" | null {
  const entry = findActivity(activity);
  return entry?.defaultFormat ?? null;
}

/** True when `topic` is one of the generic filler words. Case-insensitive, trims whitespace. */
export function isGenericTopic(topic: string | null | undefined): boolean {
  if (!topic) return false;
  return GENERIC_TOPICS.has(topic.trim().toLowerCase());
}

/** Natural window for the proactive-widening prompt. Null if not in vocab or activity has no natural window. */
export function naturalWindowForActivity(
  activity: string | null | undefined,
): { start: string; end: string } | null {
  return findActivity(activity)?.naturalWindow ?? null;
}

/**
 * Render the canonical activity table as a markdown block for build-time
 * substitution into calendar-event-composer.md. Used by runtime-prompts/index.ts
 * when serving the composer prompt — placeholder `{{ACTIVITY_VOCAB_TABLE}}`
 * in the .md file gets replaced with the output of this function.
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
