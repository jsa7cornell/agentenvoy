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

export type PrecheckResult =
  | { kind: "deterministic-create"; args: DeterministicCreateArgs; reason: string }
  | { kind: "marco-disambiguate"; existingLinkCode: string; guest: string; reason: string }
  | { kind: "fall-through-to-sonnet"; reason: string };

export interface PrecheckInput {
  classifiedIntent: "schedule" | "profile" | "rule" | "inquire" | "unclear";
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

function escapeRegex(s: string): string {
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

export function schedulingPrecheck(input: PrecheckInput): PrecheckResult {
  if (input.classifiedIntent !== "schedule") {
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

  // Step 2: existing active link for guest?
  // "agreed" status sessions are confirmed meetings — a new request for the
  // same guest is always a new meeting, not a disambiguation candidate.
  const existing = input.activeSessions.find(
    (s) =>
      s.guestName &&
      s.guestName.toLowerCase() === named!.toLowerCase() &&
      s.status === "active" &&
      s.linkCode,
  );

  if (existing && existing.linkCode) {
    return {
      kind: "marco-disambiguate",
      existingLinkCode: existing.linkCode,
      guest: named,
      reason: `existing active link for ${named}${echoSuffix}`,
    };
  }

  // Step 3: deterministic create.
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
    reason: `named guest ${named}, no active link${echoSuffix}`,
  };
}
