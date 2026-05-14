/**
 * Build the `GreetingInput` bundle consumed by `selectGreeting().render()`.
 *
 * Extracted 2026-05-04 from the inline ~180-LOC IIFE block in
 * `app/src/app/api/negotiate/session/route.ts:~821-1000` so the same bundle
 * can be re-derived by the pre-engagement greeting-update path
 * (handleExpandLink) without re-implementing the derivation. See [GREETINGS.md
 * §11.D] for the larger update protocol; this helper is the structural pivot
 * that closes the recurring R2 "greeting says X, picker says ¬X" class.
 *
 * Pure derivation. No DB I/O, no LLM, no schedule compute. The caller resolves
 * `effectiveDuration / Format / MinDuration` and `filteredSlots` upstream and
 * passes them in — the helper just composes them into the registry input.
 *
 * Group-event greeting (`link.mode === "group"`) is NOT handled here — that
 * path is an LLM call orthogonal to the deterministic registry and stays at
 * the call site.
 */

import { hostFirstName as resolveHostFirstName } from "@/lib/host-naming";
import {
  getInviteeNames,
  getInviteeFirstNamesDisplay,
} from "@/lib/invitee-display";
import {
  formatLabel,
  computeCanonicalWeekLabel,
} from "@/lib/greeting-template";
import {
  deriveLegacy,
  hasExclusiveOverride,
  readStoredSteering,
} from "@/lib/intent";
import { isGenericTopic } from "@/lib/activity-vocab";
import { readRecurrence } from "@/lib/recurrence";
import type { Prisma } from "@prisma/client";
import type { GreetingInput } from "@/agent/greetings/registry";
import type { ScoredSlot } from "@/lib/scoring";

export interface BuildGreetingInputArgs {
  link: {
    type: string;
    recurringWindowId: string | null;
    topic: string | null;
    recurrence: Prisma.JsonValue | null;
    code?: string | null;
    inviteeName?: string | null;
    inviteeNames?: string[];
  };
  /** Parsed `link.parameters` JSON. Caller passes `parseLinkParameters(link.parameters)`. */
  linkRules: Record<string, unknown>;
  user: { name: string | null };
  session: { id: string };
  filteredSlots: ScoredSlot[];
  hostTimezone: string;
  effectiveFormat: string | undefined;
  effectiveDuration: number | undefined;
  effectiveMinDuration: number | undefined;
  isGuest: boolean;
}

export function buildGreetingInput(args: BuildGreetingInputArgs): GreetingInput {
  const {
    link,
    linkRules,
    user,
    session,
    filteredSlots,
    hostTimezone,
    effectiveFormat,
    effectiveDuration,
    effectiveMinDuration,
    isGuest,
  } = args;

  // Fallback to "the organizer" (not "Host") preserves greeting read when
  // user.name is missing — this surface is user-facing prose, not a label.
  const hostFirstName = user.name ? resolveHostFirstName(user) : "the organizer";

  const rawTopic = (link as { customTitle?: string | null }).customTitle ?? null;

  // Greeting V2 (Danny spec, 2026-04-18). Multi-invitee-aware: for a 2+
  // invitee link we greet "Will & Andrew" rather than just the first name
  // (feedback cmoc4mue0…, 2026-04-23). Single-invitee behavior unchanged.
  const inviteeNamesArr = getInviteeNames(link);
  const greeteeName = getInviteeFirstNamesDisplay(link) || "there";

  // Activity (free-form) — set by the host's LLM at create_link time.
  const activityText =
    typeof linkRules.activity === "string" && linkRules.activity.trim()
      ? linkRules.activity.trim()
      : null;

  const linkLocationForOpener =
    typeof linkRules.location === "string" && linkRules.location.trim()
      ? linkRules.location.trim()
      : null;
  const durationForOpener =
    typeof linkRules.duration === "number"
      ? linkRules.duration
      : effectiveDuration ?? null;
  const rawTimingLabel =
    typeof linkRules.timingLabel === "string" && linkRules.timingLabel.trim()
      ? linkRules.timingLabel.trim().slice(0, 80)
      : null;

  // Week-label hygiene (narration-hygiene-v2 S1, 2026-04-20). When the
  // authored label says "this week" / "next week" / "the week of …", compute
  // the canonical label from the actual filtered slots and override if they
  // disagree. See route.ts comment block circa 2026-04-20 for the full why.
  const canonicalWeekLabel = computeCanonicalWeekLabel(filteredSlots, hostTimezone);
  const timingLabelLooksLikeWeek =
    rawTimingLabel && /\b(this|next)\s+week\b|\bthe\s+week\s+of\b/i.test(rawTimingLabel);
  const timingLabel =
    timingLabelLooksLikeWeek && canonicalWeekLabel
      ? canonicalWeekLabel
      : rawTimingLabel;

  const fmtLabel = formatLabel(effectiveFormat);
  const durationLabel =
    effectiveMinDuration && effectiveMinDuration < (effectiveDuration ?? 30)
      ? `${effectiveMinDuration}–${effectiveDuration}`
      : effectiveDuration
      ? `${effectiveDuration}`
      : null;
  const meetingDescShort = durationLabel && fmtLabel
    ? `${durationLabel}-min ${fmtLabel}`
    : fmtLabel
    ? fmtLabel
    : durationLabel
    ? `${durationLabel}-min meeting`
    : "meeting";

  const guestPicks = (linkRules as Record<string, unknown>).guestPicks as
    | { window?: { startHour: number; endHour: number }; date?: boolean; duration?: boolean | number[]; location?: boolean; format?: boolean | string[] }
    | undefined;
  const guestGuidance = (linkRules as Record<string, unknown>).guestGuidance as
    | { suggestions?: { locations?: string[]; durations?: number[] }; tone?: string }
    | undefined;

  const isAnonymousLink = link.type === "primary" || !!link.recurringWindowId;
  const isPrimaryLink = link.type === "primary";
  const isBookableChildLink = !!link.recurringWindowId;

  const storedSteering = readStoredSteering(linkRules);
  const effectiveSteering = storedSteering ?? deriveLegacy(linkRules);
  if (effectiveSteering === "exclusive" && !hasExclusiveOverride(linkRules)) {
    console.error(
      `[greeting] intent=exclusive with no availability.restrictToSlots (sessionId=${session.id}, linkCode=${
        (link as { code?: string | null }).code ?? "?"
      })`,
    );
  }
  const isDirective =
    effectiveSteering === "narrow" || effectiveSteering === "exclusive";

  // Bookable-slot count drives the calendar-connect pitch in `clauses.ts`.
  // "Bookable" = future slot with score ≤ 1 (matches the widget's offerable
  // predicate). The pitch itself is composed inside the templates via
  // `buildCalendarPitch`.
  const nowMs = Date.now();
  const bookableSlotCount = filteredSlots.filter(
    (s) =>
      new Date(s.start).getTime() > nowMs &&
      typeof s.score === "number" &&
      s.score <= 1,
  ).length;

  // Pre-filter `rawTopic` for the registry: the anonymous template surfaces
  // it inline, but only when it's a real host-authored topic — generic
  // chat-talk ("meeting", "catch up") gets stripped here so the registry
  // stays pure. Non-anonymous branches don't read `rawTopic`.
  const filteredTopicForRegistry =
    rawTopic && !isGenericTopic(rawTopic) ? rawTopic : null;

  return {
    hostFirstName,
    hostTimezone,
    greeteeName,
    inviteeCount: inviteeNamesArr.length,
    linkRules,
    isAnonymousLink,
    isPrimaryLink,
    isBookableChildLink,
    effectiveSteering,
    activityText,
    linkLocationForOpener,
    durationForOpener,
    effectiveDuration,
    effectiveFormat,
    rawTopic: filteredTopicForRegistry,
    meetingDescShort,
    timingLabel,
    guestPicks: guestPicks ?? null,
    guestGuidance: guestGuidance ?? null,
    bookableSlotCount,
    isGuest,
    isDirective,
    toneLine: guestGuidance?.tone ? guestGuidance.tone : null,
    recurrence: readRecurrence(link.recurrence),
    occurrenceIndex: null,
  };
}
