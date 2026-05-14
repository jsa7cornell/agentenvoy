/**
 * Single-source-of-truth title computation for confirmed meetings.
 *
 * 2026-05-12 event-data-model-google-aligned-and-meeting-tip proposal (PR-2):
 * eliminates the `actions.ts:1544` ↔ `deal-room.tsx:1654` title-computation
 * drift. Every code path that builds a meeting title routes through here.
 *
 * Algorithm (preserves behavior of `actions.ts:1544` formula):
 *   1. If `customTitle` is set, return it verbatim (host-named override).
 *   2. Else:
 *      - Group: prefix from activity → "{Prefix} ({first names display})"
 *        or just "{first names display}" if no prefix.
 *      - 1:1: "{Prefix}: {invitee display} + {host first name}" or
 *        "{invitee display} + {host first name}" if no prefix.
 *   3. Falls back to "Meeting" when nothing else is available.
 *
 * `prefix` is derived from activity (title-case canonical name) when activity
 * is in the vocab. Format-only callers (no activity) pass `prefix` directly
 * — typically "Call" / "VC" / etc.
 *
 * PR-3 (deferred): every existing `link.topic`-based title computation
 * migrates to call `buildEventTitle({customTitle, activity, ...})` and reads
 * `customTitle` instead of `topic` from the link record. The shim period
 * uses `customTitle ?? topic` as the input until PR-3 completes the
 * switchover.
 */

import { findActivity } from "./activity-vocab";

export type BuildEventTitleInput = {
  /** Explicit host-named override (e.g. "Q3 board review"). When set, used
   *  verbatim and the rest of the inputs are ignored. */
  customTitle?: string | null;
  /** Canonical activity name (from activity-vocab) or a derived prefix.
   *  When matched to the vocab, the canonical name is title-cased for the
   *  prefix ("coffee" → "Coffee"). Multi-word names lose the hyphen
   *  ("bike-ride" → "Bike ride"). */
  activity?: string | null;
  /** Format used to derive a fallback prefix when activity is missing —
   *  "phone" → "Call", "video" → "VC". Matches actions.ts:1534-1537. */
  format?: "in-person" | "video" | "phone" | null;
  /** Whether this is a group event (>1 invitee). Drives the parenthesized
   *  vs. colon-joined title shape. */
  isGroup?: boolean;
  /** Single-invitee display name (e.g. "Christine"). Used for 1:1 titles. */
  inviteeDisplay?: string | null;
  /** Group invitee display (e.g. "Sarah, Marcus, Diane"). Used for group titles. */
  firstNamesDisplay?: string | null;
  /** Host's first name. Always required for 1:1 titles. */
  hostFirstName?: string | null;
};

const FORMAT_PREFIX_MAP: Record<string, string> = {
  phone: "Call",
  video: "VC",
};

/** Title-case the canonical activity name for use as a prefix. */
function titleCaseActivity(name: string): string {
  // "bike-ride" → "Bike ride", "coffee" → "Coffee"
  const spaced = name.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Build the canonical event title from the inputs above.
 *
 * Pure function — no I/O, no DB access. Safe to call from anywhere.
 */
export function buildEventTitle(input: BuildEventTitleInput): string {
  // Custom title wins outright.
  if (input.customTitle && input.customTitle.trim()) {
    return input.customTitle.trim();
  }

  // 2026-05-14 cmp51ltr5: em-dash composite activities ("call — Using AI at
  // Sugarbowl", "coffee — Q3 launch") carry BOTH a verb-activity AND a topic
  // in a single field per the prompt's VERB+TOPIC convention. Extract the
  // topic and use it as the title verbatim — the topic IS the meeting name
  // the host gave. The verb part still drives downstream prefix lookup
  // (vocab/format), but the topic wins for display.
  //
  // Pre-fix the title-build code path treated em-dash strings as opaque:
  // findActivity returned null (em-dash composite not in vocab), the topic
  // never made it into the rendered title, and "call — Using AI at
  // Sugarbowl" produced "VC: Mark Beavor + John" — losing the host's
  // intended title entirely.
  let activityForLookup = input.activity?.trim() || null;
  if (activityForLookup) {
    // Split on the em-dash character regardless of surrounding whitespace.
    // The prompt convention is "{verb} — {topic}" but trim() upstream may
    // have stripped the trailing space (so "coffee — " arrives as
    // "coffee —"). A `.includes(" — ")` check misses that variant.
    const emDashMatch = activityForLookup.match(/^(.+?)\s*—\s*(.*)$/);
    if (emDashMatch) {
      const verb = emDashMatch[1].trim();
      const topic = emDashMatch[2].trim();
      if (topic) {
        // Topic wins as the title. Don't fall through to vocab/format prefix
        // composition. The verb part still flows through downstream surfaces
        // (emoji, format inference) via the link's `parameters.activity`
        // field — that storage shape is unchanged.
        return topic;
      }
      // Defensive: if the topic side is empty ("call — "), strip the
      // em-dash and continue with just the verb.
      activityForLookup = verb || null;
    }
  }

  // Derive activity prefix from vocab match; fall back to format mapping.
  // 2026-05-14 cmp4u*: when the matched entry defines a `prefixByFormat`
  // override for the host's chosen format, that wins over the title-cased
  // canonical name. Only `call` uses this today ("Call" for phone, "VC" for
  // video). Pre-fix, vocab match for "call" + format=video produced "Call:
  // Calle + John" because the title-case path didn't know the format mattered.
  let prefix: string | null = null;
  if (activityForLookup) {
    const entry = findActivity(activityForLookup);
    if (entry) {
      const byFormat = input.format ? entry.prefixByFormat?.[input.format] : undefined;
      if (byFormat) {
        prefix = byFormat;
      } else {
        prefix = titleCaseActivity(entry.name);
      }
    }
  }
  if (!prefix && input.format && FORMAT_PREFIX_MAP[input.format]) {
    prefix = FORMAT_PREFIX_MAP[input.format];
  }

  const isGroup = input.isGroup ?? false;
  const inviteeDisplay = input.inviteeDisplay?.trim() || null;
  const firstNamesDisplay = input.firstNamesDisplay?.trim() || null;
  const hostFirstName = input.hostFirstName?.trim() || null;

  if (isGroup) {
    if (prefix && firstNamesDisplay) return `${prefix} (${firstNamesDisplay})`;
    if (firstNamesDisplay) return firstNamesDisplay;
    if (prefix) return prefix;
    return "Meeting";
  }

  // 1:1
  if (!inviteeDisplay) {
    return prefix ?? "Meeting";
  }
  if (prefix && hostFirstName) {
    return `${prefix}: ${inviteeDisplay} + ${hostFirstName}`;
  }
  if (hostFirstName) {
    return `${inviteeDisplay} + ${hostFirstName}`;
  }
  return prefix ? `${prefix}: ${inviteeDisplay}` : inviteeDisplay;
}
