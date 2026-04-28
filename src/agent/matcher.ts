/**
 * Deterministic scheduling precheck.
 *
 * Proposal 2026-04-22 chat-intent-router §9.3.3 (PR-δ, replaces dropped PR-γ).
 *
 * Runs AFTER the Haiku intent classifier decides `schedule` and BEFORE the
 * Sonnet scheduling-pass call. If we can resolve a named guest from the
 * message or recent thread turns, we either:
 *   - emit a deterministic create_link (when no active link exists for that
 *     guest), letting Sonnet produce only confirmation prose, or
 *   - emit a Marco-style disambiguation turn asking whether the host wants a
 *     second link or a tweak to the existing one (skipping Sonnet entirely).
 *
 * Everything else falls through to the existing Sonnet pipeline.
 *
 * Extractors are regex-plus-lookup per §9.3.3: simple, not perfect. The v1
 * target is catching cases where the data is literally in the context block
 * (Failure-D class — named guest + topic both sitting in active sessions or
 * the immediate thread, yet Sonnet asks "who's the bike ride with?").
 */

// ---------------------------------------------------------------------------
// Topic allowlist — curated, short, alphabetized. Matched case-insensitive as
// a whole phrase (word-boundary). Kept intentionally small; extend only when
// a real bench-test case needs it (§9.5 bench will drive additions).
// ---------------------------------------------------------------------------
const TOPIC_ALLOWLIST: readonly string[] = [
  "1:1",
  "bike ride",
  "brainstorm",
  "call",
  "catch up",
  "check in",
  "coffee",
  "demo",
  "dinner",
  "interview",
  "intro",
  "lunch",
  "quick connect",
  "sync",
  "walk",
];

// ---------------------------------------------------------------------------
// Naming stopwords — words that can appear in "with X" / "for X" / "and X"
// patterns but are NOT names. Used by messageNamesUnrecognizedGuest() to
// avoid suppressing the thread fallback for benign phrases like "for me",
// "with the team", "next Monday".
// ---------------------------------------------------------------------------
const NAMING_STOPWORDS: ReadonlySet<string> = new Set([
  // pronouns
  "me", "you", "him", "her", "them", "us", "it", "i", "we", "they", "he", "she",
  // determiners
  "the", "a", "an", "this", "that", "these", "those",
  // possessives
  "my", "your", "his", "our", "their",
  // generic people words
  "someone", "anyone", "somebody", "anybody", "everyone", "everybody",
  "people", "nobody", "team", "guys", "folks", "everybody", "all",
  // time words
  "now", "today", "tomorrow", "tonight", "yesterday", "next", "last",
  "morning", "afternoon", "evening", "night", "soon", "later", "then",
  // weekdays
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  // months
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
  // affirmations
  "yes", "no", "ok", "okay", "sure", "maybe",
]);

export type PrecheckResult =
  | { kind: "deterministic-create"; args: DeterministicCreateArgs; reason: string }
  | { kind: "deterministic-modify"; sessionId: string; linkCode: string; reason: string }
  | { kind: "deterministic-cancel"; sessionId: string; linkCode: string; reason: string }
  | {
      kind: "multi-match-disambiguate";
      matchedLinkIds: string[];
      matchedSessions: Array<{ linkCode: string; guest: string; topic: string }>;
      originatingIntent: "create_link" | "modify_link" | "cancel_link";
      reason: string;
    }
  | { kind: "fall-through-to-sonnet"; reason: string };

/**
 * Classified intents the precheck recognises.
 *
 * - The new host enum split (`create_link` / `modify_link` / `cancel_link`)
 *   per the 2026-04-27 chat-decisioning-layer-redesign proposal.
 * - The legacy `"schedule"` value is kept exclusively for the guest call-site
 *   (`/api/negotiate/message` → administrator) so this module remains a
 *   single resolution surface during the migration. Host call-sites must
 *   pass one of the new event-shaped intents instead.
 * - Non-event intents (`profile` / `rule` / `inquire` / `unclear`) fall
 *   through immediately at the top gate.
 */
export type PrecheckClassifiedIntent =
  | "create_link"
  | "modify_link"
  | "cancel_link"
  | "schedule"
  | "profile"
  | "rule"
  | "inquire"
  | "unclear";

export interface PrecheckInput {
  classifiedIntent: PrecheckClassifiedIntent;
  userMessage: string;
  activeSessions: Array<{
    id: string;
    title: string | null;
    guestName: string | null; // from link.inviteeName
    linkCode: string | null;
    status: string; // "active" | "agreed" | etc
  }>;
  recentThreadTurns: Array<{ role: string; content: string }>; // last ~10
  echoFlag: boolean; // from PR-β's echo detector
}

export interface DeterministicCreateArgs {
  inviteeName: string;
  topic: string | null;
  duration: number | null; // minutes
  dateRangeKeyword: string | null; // "next week" | "this week" | "tomorrow" | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word match (uses word boundaries). */
function wholeWordMatch(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const re = new RegExp(`\\b${escapeRegex(needle)}\\b`, "i");
  return re.test(haystack);
}

/**
 * Find all guest-name candidates from active sessions that appear as whole
 * words in the message. Returns unique names (case-insensitive dedup,
 * preserves the active-session casing).
 */
function findGuestsInText(
  text: string,
  candidates: string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    if (seen.has(c.toLowerCase())) continue;
    if (wholeWordMatch(text, c)) {
      seen.add(c.toLowerCase());
      out.push(c);
    }
  }
  return out;
}

/**
 * Detect whether the current message names a person who is NOT one of the
 * known active-session guests. Used to suppress the thread-fallback when the
 * host is clearly asking about a new guest.
 *
 * 2026-04-27 prod regression (PR-ε): host had an active link with Katie, then
 * asked "get time with bob, phone call". `findGuestsInText(message)` returned
 * empty, the code fell through to the thread-fallback, and matched Katie from
 * earlier turns — producing a marco-disambiguate for the wrong guest.
 *
 * Heuristic: scan for "with X", "for X", "and X" where X is a 2–30 letter
 * word, lower-case it, drop NAMING_STOPWORDS and any token equal to a known
 * active-session guest. If anything remains, the message is naming someone
 * unrecognized → suppress the thread fallback and let Sonnet handle it.
 *
 * Intentionally permissive — false positives (suppressing thread fallback)
 * are recovered by Sonnet, false negatives (the bug we just hit) are not.
 */
export function messageNamesUnrecognizedGuest(
  message: string,
  knownCandidates: string[],
): boolean {
  const known = new Set(knownCandidates.map((c) => c.toLowerCase()));
  const re = /\b(?:with|for|and)\s+([A-Za-z]{2,30})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const candidate = m[1].toLowerCase();
    if (NAMING_STOPWORDS.has(candidate)) continue;
    if (known.has(candidate)) continue;
    return true;
  }
  return false;
}

/**
 * Extract a topic from the message. Two strategies:
 *   1. Whole-phrase match against recent session titles (with the guest name
 *      stripped from the title).
 *   2. Fallback: whole-phrase match against TOPIC_ALLOWLIST.
 */
function extractTopic(
  message: string,
  guest: string | null,
  sessions: PrecheckInput["activeSessions"],
  recentThreadTurns: PrecheckInput["recentThreadTurns"],
): string | null {
  const haystack = message;
  // Strategy 1: session-title phrases.
  for (const s of sessions) {
    if (!s.title) continue;
    let t = s.title;
    if (guest) {
      // Strip guest name + common joiners from the title.
      t = t.replace(new RegExp(`\\b${escapeRegex(guest)}\\b`, "gi"), "");
      t = t.replace(/\s*\+\s*/g, " ").replace(/\s+/g, " ").trim();
    }
    if (t && t.length >= 2 && wholeWordMatch(haystack, t)) {
      return t.toLowerCase();
    }
  }
  // Strategy 2: allowlist against message.
  for (const topic of TOPIC_ALLOWLIST) {
    if (wholeWordMatch(haystack, topic)) return topic;
  }
  // Strategy 3: allowlist against recent thread turns (any role).
  const threadText = recentThreadTurns.map((t) => t.content).join("\n");
  for (const topic of TOPIC_ALLOWLIST) {
    if (wholeWordMatch(threadText, topic)) return topic;
  }
  return null;
}

function extractDuration(message: string): number | null {
  const re = /(\d+)[\s-]*(h|hr|hour|min|minute)s?\b/i;
  const m = message.match(re);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  const minutes = unit.startsWith("h") ? n * 60 : n;
  if (minutes < 10 || minutes > 480) return null; // implausible
  return minutes;
}

function extractDateRangeKeyword(message: string): string | null {
  const lower = message.toLowerCase();
  if (/\bnext week\b/.test(lower)) return "next week";
  if (/\bthis week\b/.test(lower)) return "this week";
  if (/\btomorrow\b/.test(lower)) return "tomorrow";
  return null;
}

/** Collect guest-name candidates from active sessions (inviteeName). */
function guestCandidates(sessions: PrecheckInput["activeSessions"]): string[] {
  const out: string[] = [];
  for (const s of sessions) {
    if (s.guestName && s.guestName.trim().length > 0) {
      out.push(s.guestName.trim());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Build the `matchedSessions` payload for a multi-match-disambiguate result.
 * Strips the guest's name out of the title to leave a topic-only descriptor;
 * empties become "session" so the marco prose still has something to render.
 */
function buildMatchedSessions(
  matched: PrecheckInput["activeSessions"],
  guest: string,
): Array<{ linkCode: string; guest: string; topic: string }> {
  return matched
    .filter((s): s is typeof s & { linkCode: string } => Boolean(s.linkCode))
    .map((s) => {
      let topic = s.title ?? "";
      if (topic) {
        topic = topic.replace(new RegExp(`\\b${escapeRegex(guest)}\\b`, "gi"), "");
        topic = topic.replace(/\s*\+\s*/g, " ").replace(/\s+/g, " ").trim();
      }
      return {
        linkCode: s.linkCode,
        guest,
        topic: topic || "session",
      };
    });
}

export function schedulingPrecheck(input: PrecheckInput): PrecheckResult {
  // Top gate: only run guest-resolution for event-shaped intents. Per the
  // 2026-04-27 chat-decisioning-layer-redesign §2.2/§2.3, the new host
  // enum splits the legacy `"schedule"` into create/modify/cancel; the
  // guest endpoint still passes `"schedule"` and is handled identically
  // to `create_link` in this module (zero guest-pipeline regression).
  const eventShaped =
    input.classifiedIntent === "create_link" ||
    input.classifiedIntent === "modify_link" ||
    input.classifiedIntent === "cancel_link" ||
    input.classifiedIntent === "schedule";

  if (!eventShaped) {
    return {
      kind: "fall-through-to-sonnet",
      reason: `intent is ${input.classifiedIntent}`,
    };
  }

  const echoSuffix = input.echoFlag ? " (echo of prior envoy detected)" : "";

  // Step 1: named guest — message first, then recent thread turns.
  const activeCandidates = guestCandidates(input.activeSessions);
  let named: string | null = null;
  const inMessage = findGuestsInText(input.userMessage, activeCandidates);
  if (inMessage.length > 1) {
    return {
      kind: "fall-through-to-sonnet",
      reason: `multiple guest candidates: ${inMessage.join(", ")}${echoSuffix}`,
    };
  }
  if (inMessage.length === 1) {
    named = inMessage[0];
  } else {
    // Guard before thread-fallback: if the message itself names a *new*
    // person (not in active sessions), don't anchor on a stale guest from
    // earlier turns. PR-ε / 2026-04-27 prod regression — see helper above.
    if (messageNamesUnrecognizedGuest(input.userMessage, activeCandidates)) {
      return {
        kind: "fall-through-to-sonnet",
        reason: `message names unrecognized guest${echoSuffix}`,
      };
    }
    // Fallback: guest names from active sessions appearing in the last ~10
    // thread turns (not the current message, which we already checked).
    const threadText = input.recentThreadTurns.map((t) => t.content).join("\n");
    const inThread = findGuestsInText(threadText, activeCandidates);
    if (inThread.length > 1) {
      return {
        kind: "fall-through-to-sonnet",
        reason: `multiple guest candidates: ${inThread.join(", ")}${echoSuffix}`,
      };
    }
    if (inThread.length === 1) named = inThread[0];
  }

  if (!named) {
    return {
      kind: "fall-through-to-sonnet",
      reason: `no named guest${echoSuffix}`,
    };
  }

  // Step 2: collect existing active/agreed sessions for the named guest.
  // Both "active" and "agreed" count as existing links — the multi-match
  // surface ("you have two Katie links") is the SAME for both statuses.
  const existingMatches = input.activeSessions.filter(
    (s) =>
      s.guestName &&
      s.guestName.toLowerCase() === named!.toLowerCase() &&
      (s.status === "active" || s.status === "agreed") &&
      s.linkCode,
  );

  const matchCount = existingMatches.length;
  const intent = input.classifiedIntent;

  // ---------------------------------------------------------------------
  // CREATE_LINK (and legacy "schedule")
  // ---------------------------------------------------------------------
  // Per §2.3 R1 verification (handleCreateLink is reversible-without-side-
  // effects pre-confirm), a single match defaults to create. Multi-match
  // genuinely needs the user to pick which existing link they meant — that's
  // when marco fires. The previous "active or agreed → marco" branch is
  // dropped entirely (PLAYBOOK Rule 19e protects against re-introduction).
  if (intent === "create_link" || intent === "schedule") {
    // Explicit-create-another bypass: when the host's wording clearly says
    // "I want a NEW link in addition to whatever exists" ("add another
    // meeting with katie", "create a new one for katie", "second katie
    // meeting"), skip multi-match disambiguation and go straight to
    // deterministic-create. Symmetric with the marcoPending replay
    // bypass in /api/channel/chat — the same keyword set short-circuits
    // disambiguation in BOTH directions (before and after marco fires).
    // Bug repro 2026-04-28: "add another meeting with katie" was wrongly
    // marco-disambiguating against existing Katie links.
    const explicitAnother = /\b(another|additional|second|new|fresh)\b/i.test(
      input.userMessage,
    );
    if (matchCount >= 2 && !explicitAnother) {
      return {
        kind: "multi-match-disambiguate",
        matchedLinkIds: existingMatches
          .map((s) => s.linkCode)
          .filter((c): c is string => Boolean(c)),
        matchedSessions: buildMatchedSessions(existingMatches, named),
        originatingIntent: "create_link",
        reason: `multi-match for ${named}: ${matchCount} active/agreed links${echoSuffix}`,
      };
    }
    // 0, 1, or 2+ (with explicit-another) match → deterministic create.
    const topic = extractTopic(
      input.userMessage,
      named,
      input.activeSessions,
      input.recentThreadTurns,
    );
    const duration = extractDuration(input.userMessage);
    const dateRangeKeyword = extractDateRangeKeyword(input.userMessage);
    return {
      kind: "deterministic-create",
      args: {
        inviteeName: named,
        topic,
        duration,
        dateRangeKeyword,
      },
      reason:
        matchCount === 0
          ? `named guest ${named}, no active link${echoSuffix}`
          : `named guest ${named}, single match defaults to create (R1)${echoSuffix}`,
    };
  }

  // ---------------------------------------------------------------------
  // MODIFY_LINK
  // ---------------------------------------------------------------------
  if (intent === "modify_link") {
    if (matchCount >= 2) {
      return {
        kind: "multi-match-disambiguate",
        matchedLinkIds: existingMatches
          .map((s) => s.linkCode)
          .filter((c): c is string => Boolean(c)),
        matchedSessions: buildMatchedSessions(existingMatches, named),
        originatingIntent: "modify_link",
        reason: `multi-match for ${named}: ${matchCount} active/agreed links${echoSuffix}`,
      };
    }
    if (matchCount === 1) {
      const m = existingMatches[0];
      return {
        kind: "deterministic-modify",
        sessionId: m.id,
        linkCode: m.linkCode!,
        reason: `single match for ${named}, modify_link${echoSuffix}`,
      };
    }
    return {
      kind: "fall-through-to-sonnet",
      reason: `modify_link with no existing link for ${named}${echoSuffix}`,
    };
  }

  // ---------------------------------------------------------------------
  // CANCEL_LINK
  // ---------------------------------------------------------------------
  if (intent === "cancel_link") {
    if (matchCount >= 2) {
      return {
        kind: "multi-match-disambiguate",
        matchedLinkIds: existingMatches
          .map((s) => s.linkCode)
          .filter((c): c is string => Boolean(c)),
        matchedSessions: buildMatchedSessions(existingMatches, named),
        originatingIntent: "cancel_link",
        reason: `multi-match for ${named}: ${matchCount} active/agreed links${echoSuffix}`,
      };
    }
    if (matchCount === 1) {
      const m = existingMatches[0];
      return {
        kind: "deterministic-cancel",
        sessionId: m.id,
        linkCode: m.linkCode!,
        reason: `single match for ${named}, cancel_link${echoSuffix}`,
      };
    }
    return {
      kind: "fall-through-to-sonnet",
      reason: `cancel_link with no existing link for ${named}${echoSuffix}`,
    };
  }

  // Unreachable per the eventShaped gate above; defensive.
  return {
    kind: "fall-through-to-sonnet",
    reason: `unhandled intent ${intent}${echoSuffix}`,
  };
}
