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

  // Derive activity prefix from vocab match; fall back to format mapping.
  let prefix: string | null = null;
  if (input.activity) {
    const entry = findActivity(input.activity);
    if (entry) prefix = titleCaseActivity(entry.name);
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
