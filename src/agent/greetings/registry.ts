/**
 * Greeting registry — deterministic 1:1 / 1:many first-message templates.
 *
 * Each entry is a `GreetingTemplate` keyed by string. `selectGreeting(input)`
 * returns the matching template; `template.render(input)` returns the final
 * greeting string. Route handlers stay thin — build the input once, dispatch
 * via the registry, save the result.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * What belongs IN this registry
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Deterministic templates only — no LLM calls, no hallucination risk. Every
 * field that flows into the rendered string must be either:
 *   - Already on the link / session / user record (host name, topic,
 *     activity, format, duration, location, timingLabel), or
 *   - Computed by a pure helper from those fields (e.g., `formatDuration`,
 *     `formatLabel`, the `withClause` / `findTimeWithClause` derivations).
 *
 * Adding a new template variant
 * ----------------------------
 *   1. Add a new key to `GREETING_KEYS`.
 *   2. Add a new entry to `GREETINGS` with its `match()` and `render()`.
 *   3. Decide where it sits in `selectGreeting`'s priority order — current
 *      order is single-slot-lock → anonymous → proposal → find-time, with
 *      proposal/find-time differentiated by `hasProposalSubstance`. Insert
 *      a new branch where its match condition is the most specific.
 *   4. Add a parity unit test in `src/__tests__/unit/greeting-registry.test.ts`
 *      asserting byte-identical output for at least one fixture per branch.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * What stays OUTSIDE the registry
 * ────────────────────────────────────────────────────────────────────────────
 *
 * **Group-event greeting.** Today's group-event path in
 * `app/src/app/api/negotiate/session/route.ts` (the `if (isGroupEvent)` block
 * above the registry call) routes through `generateAgentResponse` because
 * the greeting needs participant-aware framing ("3 of 5 have responded — Tue
 * afternoon is the only window everyone's free"). That requires calendar-
 * intersection prose the deterministic templates can't author. A templated
 * group entry is wishlisted ([WISHLIST.md] Tier 2: "Group-event greeting —
 * convert to templated registry entry"); when it lands, it slots in here as
 * a fifth registry key.
 *
 * **Bilateral guest-Envoy greeting.** Disabled 2026-04-23. If re-enabled, it
 * goes through `lib/guest-greeting-template.ts`, not this registry — guest-
 * voice is a separate template lineage with different framing rules.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Voice gate (do not change without architect approval)
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   isAnonymousLink = link.type === "primary" || !!link.recurringWindowId
 *   (both isPrimaryLink=true and isBookableChildLink=true fire anonymous voice)
 *
 * Anonymous voice fires on the primary link AND on bookable links backed by a
 * recurring window. All other bookable variants and single-use links use
 * personalized voice. See [SPEC.md §2.5.4 + §3.6].
 */

import { formatDuration } from "@/lib/format-duration";
import { formatCadenceWord, formatEndByLabel } from "@/lib/format-recurrence";
import { formatLabel } from "@/lib/greeting-template";
import { isSingleSlotExclusive } from "@/lib/intent";
import type { Steering } from "@/lib/intent";
import type { LinkRecurrence } from "@/lib/recurrence";
import {
  buildCalendarPitch,
  buildDeferralFieldsList,
  buildGuestPickHint,
  buildSuggestAltClause,
  type GuestGuidanceConfig,
  type GuestPicksConfig,
} from "./clauses";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Stable identifier for each template variant. The wire response does not
 * surface this key; it's purely a registry-internal handle for selection
 * and tests.
 */
export const GREETING_KEYS = [
  "single-slot-lock",
  "recurring-meeting-anchor",
  "recurring-meeting-followup",
  "anonymous",
  "proposal",
  "find-time",
] as const;

export type GreetingKey = (typeof GREETING_KEYS)[number];

/**
 * Canonical deferral-field nouns used in guest-facing greetings, follow-up
 * messages, and event-card "(proposed)" indicators. Adding a new deferral
 * dimension means adding it to this set AND wiring it through the four
 * surfaces enumerated in §3.F of the 2026-04-29 link-handler-consolidation
 * proposal.
 *
 * Order is intentional: the canonical sort applied by
 * `formatDeferralFieldsList` so guest-facing copy is consistent across
 * surfaces ("the length and location", not sometimes "the location and length").
 */
export const DEFERRAL_FIELD_NOUNS = ["location", "length", "day", "format"] as const;
export type DeferralFieldNoun = (typeof DEFERRAL_FIELD_NOUNS)[number];

/**
 * Format a list of deferral-field nouns into a human-readable phrase used
 * in the greeting opener ("...preferences in terms of {list}") and closing
 * ("...any suggestions on {list}"). Returns null when no fields are
 * deferred (caller falls back to non-deferral copy).
 *
 *   1 → "the location"
 *   2 → "the length and location"
 *   3 → "the day, length, and location"
 *   4 → "the day, length, format, and location"
 *
 * "and" rather than "or" — the guest is being asked to weigh in on multiple
 * aspects, not pick one. Differs from the host-side update-confirmation
 * copy (actions.ts → "Feel free to suggest a length or location") which
 * uses "or" for "you can pick this OR that" framing.
 */
export function formatDeferralFieldsList(
  deferred: readonly DeferralFieldNoun[],
): string | null {
  if (deferred.length === 0) return null;
  // Apply canonical order so the same set of fields renders identically
  // regardless of input order.
  const sorted = DEFERRAL_FIELD_NOUNS.filter((n) => deferred.includes(n));
  if (sorted.length === 1) return `the ${sorted[0]}`;
  if (sorted.length === 2) return `the ${sorted[0]} and ${sorted[1]}`;
  return `the ${sorted.slice(0, -1).join(", ")}, and ${sorted[sorted.length - 1]}`;
}

/**
 * The full input bundle a registry render needs. Built once by the route
 * handler from link / session / user / scoring outputs and passed to
 * `selectGreeting(input).render(input)`.
 *
 * Field shapes mirror what was previously inlined in
 * `app/src/app/api/negotiate/session/route.ts:782-1083`. Voice-equivalence
 * tests assert byte-identity against the prior inline output.
 */
export interface GreetingInput {
  /** Host's first name (e.g., "John"). */
  hostFirstName: string;
  /** Host's IANA timezone, used for the single-slot-lock day/time format. */
  hostTimezone: string;

  /** Display name for the addressee — "Sarah", "Will & Andrew", or "there". */
  greeteeName: string;
  /** Number of invitees on this link (1 for single-invitee, 2+ for 1:many). */
  inviteeCount: number;

  /** Sanitized link-rules blob (the `link.parameters` JSON column). */
  linkRules: Record<string, unknown>;

  /** True iff `link.type === "primary" || !!link.recurringWindowId`. */
  isAnonymousLink: boolean;
  /** True iff `link.type === "primary"`. */
  isPrimaryLink: boolean;
  /** True iff `link.recurringWindowId != null` (recurring-window-backed bookable child link). */
  isBookableChildLink: boolean;

  /** Host-classified steering tier (open / soft / narrow / exclusive). */
  effectiveSteering: Steering;

  /** Free-form activity text from create_link, e.g. "hike". Null if absent. */
  activityText: string | null;
  /** Link-rule location from create_link, e.g. "Central Park". Null if absent. */
  linkLocationForOpener: string | null;
  /** Effective duration in minutes (link rule → host pref → session). */
  durationForOpener: number | null;
  /**
   * Resolved duration for the single-slot-lock template specifically.
   * Tracked separately because the original inline branch used `effectiveDuration`
   * (which falls through `||` for falsy values like 0) where B-proposal used
   * `durationForOpener` (which uses `??`). Same value in practice for all
   * realistic inputs; carried as a distinct field to lock byte-equivalence.
   */
  effectiveDuration: number | undefined;
  /** Resolved meeting format ("video" / "phone" / "in-person"). */
  effectiveFormat: string | undefined;
  /** Topic from `link.topic`, post-`isGenericTopic` filter (caller decides). */
  rawTopic: string | null;
  /** Pre-formatted "30-min video call" / "meeting" string for anonymous body. */
  meetingDescShort: string;

  /** Resolved timing label after canonical-week override (may be null). */
  timingLabel: string | null;

  /**
   * Raw `link.parameters.guestPicks` config. Templates compose clauses from
   * this via `clauses.ts` helpers (`buildGuestPickHint`, `buildSuggestAltClause`,
   * `buildDeferralFieldsList`).
   *
   * Refactored 2026-05-03 from four pre-rendered string fields
   * (`guestPickHint` / `suggestAltClause` / `deferralFieldsList` / `calendarPitch`)
   * into raw inputs — see [GREETINGS.md §11.A].
   */
  guestPicks: GuestPicksConfig | null;

  /**
   * Raw `link.parameters.guestGuidance` config (location suggestions, tone).
   * Templates read `tone` directly; `suggestions.locations` flow into
   * `buildGuestPickHint`.
   */
  guestGuidance: GuestGuidanceConfig | null;

  /**
   * Number of future slots with score ≤ 1 (matches the picker's offerable
   * predicate). Drives `buildCalendarPitch` — pitch fires only when >1
   * bookable slot exists AND the viewer is anonymous.
   */
  bookableSlotCount: number;

  /**
   * Whether the viewer is a logged-in guest (authenticated User who is
   * NOT the host). Suppresses the calendar-connect pitch — logged-in
   * guests already have app-level calendar access.
   */
  isGuest: boolean;

  /**
   * Whether the link's effective steering is narrow or exclusive. Used by
   * `buildSuggestAltClause` and `buildDeferralFieldsList` to skip clauses
   * the host explicitly declined to defer.
   */
  isDirective: boolean;

  /** Sanitized host tone string from guidance, surfaced verbatim. May be null. */
  toneLine: string | null;

  /**
   * Recurrence config copied from `link.recurrence` via `readRecurrence()`.
   * Null for single (non-recurring) meetings.
   *
   * Present for both creation paths that produce a recurring meeting:
   *   - Direct contextual: `handleCreateLink` with `recurrence` populated
   *     ("10 weekly piano lessons with Pat").
   *   - Office-hours-with-series: materialized child link where
   *     `buildRecurrenceFromSeries(oh.series)` was copied into `link.recurrence`
   *     at visit time.
   *
   * When non-null, drives the recurring-meeting-anchor / recurring-meeting-followup
   * template selection. Other templates ignore this field.
   */
  recurrence: LinkRecurrence | null;

  /**
   * Which occurrence this session represents, 0-based. Null at the
   * anchor-pick visit (guest hasn't committed to a first slot yet).
   * 0 = anchor occurrence; ≥1 = follow-up occurrence.
   *
   * Drives the anchor vs. followup template split:
   *   null → recurring-meeting-anchor (guest picks the first slot)
   *   ≥1   → recurring-meeting-followup (subsequent session reminder)
   *
   * NOTE: wired from `LinkOccurrence.occurrenceIndex` once that lookup is
   * added to the session/route.ts assembly. Pass null for all sessions
   * until then — the anchor template fires correctly for the current
   * first-visit use case.
   */
  occurrenceIndex: number | null;
}

export interface GreetingTemplate {
  key: GreetingKey;
  description: string;
  /**
   * Pure predicate: does this input route to this template? Order of evaluation
   * matters — see `selectGreeting`. Returning true does not preclude a more
   * specific entry being selected first.
   */
  match: (input: GreetingInput) => boolean;
  render: (input: GreetingInput) => string;
}

// ─── Helper: with-clause derivations (multi-invitee aware) ───────────────────

/**
 * "with you and {Host}" / "with the three of you" / "with you all".
 * Mirrors the inline derivation from route.ts:1051-1057.
 */
function buildWithClause(input: GreetingInput): string {
  const { hostFirstName, inviteeCount } = input;
  if (inviteeCount <= 1) return `with you and ${hostFirstName}`;
  const total = inviteeCount + 1;
  if (total === 3) return "with the three of you";
  if (total === 4) return "with the four of you";
  return "with you all";
}

/**
 * " for the three of you" / " for the four of you" / " for your group" / "".
 * Mirrors the inline derivation from route.ts:1058-1064. Single-invitee
 * returns empty string so the parent template can concatenate without a
 * trailing space.
 */
function buildFindTimeWithClause(input: GreetingInput): string {
  const { inviteeCount } = input;
  if (inviteeCount <= 1) return "";
  const total = inviteeCount + 1;
  if (total === 3) return " for the three of you";
  if (total === 4) return " for the four of you";
  return " for your group";
}

/**
 * Compose the `{xxx}` in "He's proposing {xxx}." — mirrors `buildProposalPhrase`
 * from route.ts:963-983. Pure function over GreetingInput.
 */
function buildProposalPhrase(input: GreetingInput): string {
  const { activityText, durationForOpener, effectiveFormat, linkLocationForOpener, timingLabel } = input;
  const durStr = durationForOpener ? formatDuration(durationForOpener) : null;
  const fmtWord = formatLabel(effectiveFormat);
  let head: string;
  if (activityText) {
    const article = /^[aeiou]/i.test(activityText) ? "an" : "a";
    head = durStr ? `${durStr} for ${activityText}` : `${article} ${activityText}`;
  } else if (durStr && fmtWord) {
    head = `a ${durStr} ${fmtWord}`;
  } else if (durStr) {
    head = durStr;
  } else if (fmtWord) {
    const article = /^[aeiou]/i.test(fmtWord) ? "an" : "a";
    head = `${article} ${fmtWord}`;
  } else {
    head = "time";
  }
  const locPart = linkLocationForOpener ? ` in ${linkLocationForOpener}` : "";
  const timingPart = timingLabel ? ` ${timingLabel}` : "";
  return `${head}${locPart}${timingPart}`;
}

/** True when the link carries any structural field beyond a bare timingLabel. */
function hasProposalSubstance(input: GreetingInput): boolean {
  return (
    !!input.effectiveFormat ||
    input.durationForOpener != null ||
    !!input.activityText ||
    !!input.linkLocationForOpener
  );
}

// ─── Branch A: single-slot exclusive ─────────────────────────────────────────

/**
 * "Envoy lined up a time — {dur} for {activity} at {loc} on {day} at {time}.
 *  Confirm below, or let me know if anything needs to shift."
 *
 * Fires when the host LLM-classified intent is `exclusive` AND the rule blob
 * carries exactly one slot at score -2 (the "lock this slot" override).
 */
const singleSlotLockTemplate: GreetingTemplate = {
  key: "single-slot-lock",
  description:
    "Single-slot exclusive lock — host pre-selected one specific time. " +
    "Greeting hands the offer card a confirm-or-shift framing.",
  match: (input) =>
    !input.isAnonymousLink &&
    input.effectiveSteering === "exclusive" &&
    isSingleSlotExclusive(input.linkRules),
  render: (input) => {
    const { greeteeName, effectiveDuration, activityText, linkLocationForOpener, hostTimezone, linkRules } = input;
    const durStr = effectiveDuration ? formatDuration(effectiveDuration) : null;
    const activityPart = activityText ? ` for ${activityText}` : "";
    const locPart = linkLocationForOpener ? ` at ${linkLocationForOpener}` : "";
    const durPart = durStr ? `${durStr}` : "some time";
    const slotStartIso = ((): string | null => {
      // 2026-05-01 — pinned exclusive slots now live in
      // `availability.restrictToSlots` (replaces legacy `slotOverrides[-2]`).
      const avail = (linkRules as { availability?: { restrictToSlots?: Array<{ start?: unknown }> } })?.availability;
      const slots = (avail?.restrictToSlots ?? []) as Array<{ start?: unknown }>;
      const hit = slots.find((s) => typeof s.start === "string");
      return hit && typeof hit.start === "string" ? hit.start : null;
    })();
    const whenPart = ((): string => {
      if (!slotStartIso) return "";
      const d = new Date(slotStartIso);
      if (Number.isNaN(d.getTime())) return "";
      const day = new Intl.DateTimeFormat("en-US", {
        timeZone: hostTimezone,
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(d);
      const time = new Intl.DateTimeFormat("en-US", {
        timeZone: hostTimezone,
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(d);
      return ` on ${day} at ${time}`;
    })();
    const proposal = `${durPart}${activityPart}${locPart}${whenPart}`;
    return `👋 ${greeteeName}! Envoy lined up a time — ${proposal}. Confirm below, or let me know if anything needs to shift.`;
  },
};

// ─── Branch R-anchor: recurring meeting, first-slot-pick visit ───────────────

/**
 * "👋 {Name}! I'm here to help you set up your {topic} sessions with {Host}.
 *  Please pick from any of the slots below — they are {dur} long, recurring
 *  {cadence} at the same time{count suffix}.
 *  If you need to change anything, I can help you make adjustments at any time."
 *
 * Fires when `link.recurrence` is set AND `occurrenceIndex` is null — the
 * guest hasn't committed to an anchor slot yet. This is the first (and usually
 * only) thing they see when opening a recurring-meeting link.
 *
 * Covers both creation paths:
 *   - Named / direct-contextual: greeteeName is "Pat" (set at create time)
 *   - Anonymous / office-hours-with-series: greeteeName is "there" (no inviteeName)
 *
 * The render is identical for both voice modes because the user's copy is
 * greeting-first ("I'm here to help you set up…") rather than introducing
 * the agent. If anonymous-specific framing is needed in future, add an
 * `isAnonymousLink` branch here.
 */
const recurringAnchorTemplate: GreetingTemplate = {
  key: "recurring-meeting-anchor",
  description:
    "First-slot-pick greeting for a recurring meeting series. " +
    "Fires when link.recurrence is set and occurrenceIndex is null.",
  // Anchor: fires for null (pre-commitment first visit) OR 0 (the anchor
  // occurrence itself). Both represent "the first session." Occurrence ≥1 is
  // the followup template's domain.
  match: (input) =>
    !!input.recurrence &&
    (input.occurrenceIndex == null || input.occurrenceIndex === 0),
  render: (input) => {
    const { greeteeName, hostFirstName, recurrence, rawTopic } = input;
    const rec = recurrence!;

    const durStr = formatDuration(rec.anchor.durationMin);
    const cadence = formatCadenceWord(rec);
    const topicNoun = rawTopic ?? "meeting";

    // Optional session count — appended in parens when host explicitly bounded
    // the series via endBy.count. Omitted for forever (default) and for
    // until-date endBy (less intuitive inline; card subtitle covers it).
    // Per the 2026-05-03 chat-driven narration reshape: series length is
    // silent unless the host asked.
    const countSuffix =
      rec.endBy && "count" in rec.endBy
        ? ` (${rec.endBy.count} session${rec.endBy.count === 1 ? "" : "s"})`
        : "";

    return [
      `👋 ${greeteeName}! I'm here to help you set up your ${topicNoun} sessions with ${hostFirstName}.`,
      `Please pick from any of the slots below — they are ${durStr} long, recurring ${cadence} at the same time${countSuffix}.`,
      `If you need to change anything, I can help you make adjustments at any time.`,
    ].join("\n\n");
  },
};

// ─── Branch R-followup: recurring meeting, subsequent occurrence ──────────────

/**
 * "👋 {Name}! Session {N} of {total} with {Host} is coming up.
 *  This is your recurring {cadence} slot — confirm below or let me know if
 *  anything needs to shift."
 *
 * Fires when `link.recurrence` is set AND `occurrenceIndex` ≥ 1 —
 * a follow-up occurrence after the anchor slot is committed.
 *
 * NOTE: `occurrenceIndex` is not yet wired from the `LinkOccurrence` table in
 * `session/route.ts`. Until that lookup lands, this template is unreachable
 * (all sessions pass `occurrenceIndex: null` → anchor template fires). It's
 * registered here so the selector priority and key are in place for when
 * the wiring ships.
 */
const recurringFollowupTemplate: GreetingTemplate = {
  key: "recurring-meeting-followup",
  description:
    "Follow-up occurrence greeting for a committed recurring series. " +
    "Fires when link.recurrence is set and occurrenceIndex >= 1. " +
    "Not yet reachable — occurrenceIndex wiring in session/route.ts is pending.",
  match: (input) =>
    !!input.recurrence &&
    input.occurrenceIndex != null &&
    input.occurrenceIndex >= 1,
  render: (input) => {
    const { greeteeName, hostFirstName, recurrence, occurrenceIndex } = input;
    const rec = recurrence!;

    // 1-based session number for display ("Session 3 of 10").
    // The "of N" suffix only renders when the host explicitly bounded the
    // series via endBy.count. Forever default and until-date are silent
    // here (the running session number alone carries the cadence).
    const sessionNum = (occurrenceIndex ?? 0) + 1;
    const totalSuffix =
      rec.endBy && "count" in rec.endBy ? ` of ${rec.endBy.count}` : "";

    const cadence = formatCadenceWord(rec);
    const endLabel = formatEndByLabel(rec);
    void endLabel; // available for future copy variants

    return [
      `👋 ${greeteeName}! Session ${sessionNum}${totalSuffix} with ${hostFirstName} is coming up.`,
      `This is your recurring ${cadence} slot — confirm below or let me know if anything needs to shift.`,
    ].join("\n\n");
  },
};

// ─── Branch C: anonymous-visitor voice ───────────────────────────────────────

/**
 * "👋 I'm {Host}'s scheduling agent.\n{body}"
 *
 * Fires on the primary link OR a bookable child link
 * (`recurringWindowId != null`). Bookable child links surface `topic` inline; bare
 * primaries fall back to the default-format pitch.
 */
const anonymousTemplate: GreetingTemplate = {
  key: "anonymous",
  description:
    "Agent-voice self-intro for anonymous visitors. Fires on type=primary " +
    "and on bookable links backed by a recurring window.",
  match: (input) => input.isAnonymousLink,
  render: (input) => {
    const { hostFirstName, isBookableChildLink, rawTopic, meetingDescShort } = input;
    const calendarPitch = buildCalendarPitch(input);
    // Bookable child links carry a `topic` (e.g. "Coaching hours"). Bare
    // primary links don't — render the default offer instead.
    const hostTopic =
      isBookableChildLink && rawTopic ? rawTopic : null;
    const pitch = calendarPitch ? ` ${calendarPitch}` : "";
    const body = hostTopic
      ? `These are ${hostFirstName}'s ${hostTopic} — ${meetingDescShort}s within the available windows below.${pitch}`
      : `${hostFirstName}'s default is ${meetingDescShort} sometime within the available windows below.${pitch}`;
    return [`👋 I'm ${hostFirstName}'s scheduling agent.`, body].join("\n");
  },
};

// ─── Branch B-proposal: named invitee, structural fields set ─────────────────

/**
 * "👋 {Name}! I'm scheduling time {with-clause}. {Host} is proposing {phrase}."
 *  + optional tone line + optional guest-pick hint + closing.
 *
 * Fires for personalized links when at least one of {format, duration,
 * activity, location} is set on the link rules.
 */
const proposalTemplate: GreetingTemplate = {
  key: "proposal",
  description:
    "Personalized voice for a link with substantive structural fields " +
    "(format / duration / activity / location).",
  match: (input) => !input.isAnonymousLink && hasProposalSubstance(input),
  render: (input) => {
    const { greeteeName, hostFirstName, toneLine, guestPicks, guestGuidance, isDirective, isBookableChildLink } = input;
    const withClause = buildWithClause(input);
    const proposalPhrase = buildProposalPhrase(input);

    // Compose clauses inline via the helpers in `clauses.ts`. Each helper
    // returns its rendered string or null; gating logic for the unified
    // opener/closing fold (2026-04-29) is applied here in the template:
    // when `deferralFieldsList` is set, it suppresses tone, guestPickHint,
    // and the standalone suggest-alt — those become redundant with the
    // unified opener+closing.
    const deferralFieldsList = buildDeferralFieldsList({ guestPicks, isDirective, isBookableChildLink });
    const calendarPitch = buildCalendarPitch(input);
    const guestPickHint = deferralFieldsList ? null : buildGuestPickHint({ guestPicks, guestGuidance, hostFirstName });
    const suggestAltClause = deferralFieldsList ? null : buildSuggestAltClause({ guestPicks, isDirective, isBookableChildLink });

    // Unified opener — when fields are deferred, append "but wanted to
    // check if you had preferences in terms of {list}".
    const openerLine = deferralFieldsList
      ? `👋 ${greeteeName}! I'm scheduling time ${withClause}. ${hostFirstName} is proposing ${proposalPhrase} but wanted to check if you had preferences in terms of ${deferralFieldsList}.`
      : `👋 ${greeteeName}! I'm scheduling time ${withClause}. ${hostFirstName} is proposing ${proposalPhrase}.`;

    // Unified closing — when fields are deferred, append "and let us know
    // any suggestions on {list}". Subsumes the standalone `suggestAltClause`
    // for the deferral case.
    let closingBase: string;
    if (deferralFieldsList) {
      closingBase = `Pick a time below and let us know any suggestions on ${deferralFieldsList}.`;
    } else if (suggestAltClause) {
      closingBase = `Pick a time below, ${suggestAltClause}.`;
    } else {
      closingBase = "Pick a time below.";
    }
    const closingParts = [closingBase];
    if (calendarPitch) closingParts.push(calendarPitch);
    const closing = closingParts.join(" ");

    const blocks: string[] = [openerLine];
    // Tone line suppressed when deferralFieldsList is set. Composers tend
    // to populate `guestGuidance.tone` with deferral-mirroring text
    // ("Larry picks the spot and how long — just let him know what works.")
    // when the host's create_link message expressed deferral, which then
    // duplicates the opener+closing copy. Skip in deferral cases; legitimate
    // flavor tone (e.g. "It's his first week back.") still renders for
    // non-deferral greetings.
    if (toneLine && !deferralFieldsList) blocks.push(toneLine);
    if (guestPickHint) blocks.push(guestPickHint);
    blocks.push(closing);
    return blocks.join("\n\n");
  },
};

// ─── Branch B-find-time: named invitee, no structural fields ─────────────────

/**
 * "👋 {Name}! {Host} asked me to find time{ for-clause}{ timingLabel}."
 *  + optional tone line + optional guest-pick hint + closing.
 *
 * Fires for personalized links with NO structural fields set — host has
 * deferred everything to the guest.
 */
const findTimeTemplate: GreetingTemplate = {
  key: "find-time",
  description:
    "Personalized voice for a link with no structural fields — host has " +
    "deferred format / duration / activity / location to the guest.",
  match: (input) => !input.isAnonymousLink && !hasProposalSubstance(input),
  render: (input) => {
    const { greeteeName, hostFirstName, timingLabel, toneLine, guestPicks, guestGuidance, isDirective, isBookableChildLink } = input;
    const findTimeWithClause = buildFindTimeWithClause(input);

    // Same clause-composition + suppression pattern as proposalTemplate.
    const deferralFieldsList = buildDeferralFieldsList({ guestPicks, isDirective, isBookableChildLink });
    const calendarPitch = buildCalendarPitch(input);
    const guestPickHint = deferralFieldsList ? null : buildGuestPickHint({ guestPicks, guestGuidance, hostFirstName });
    const suggestAltClause = deferralFieldsList ? null : buildSuggestAltClause({ guestPicks, isDirective, isBookableChildLink });

    // Find-time greeting fires when no structural fields are set — the
    // host has effectively deferred everything. The opener already says
    // "asked me to find time", which inherently invites the guest to
    // weigh in. Don't repeat "but wanted to check" here; just append the
    // closing-side suggestion clause for clarity.
    const openerLine = `👋 ${greeteeName}! ${hostFirstName} asked me to find time${findTimeWithClause}${timingLabel ? ` ${timingLabel}` : ""}.`;

    let closingBase: string;
    if (deferralFieldsList) {
      closingBase = `Pick a time below and let us know any suggestions on ${deferralFieldsList}.`;
    } else if (suggestAltClause) {
      closingBase = `Pick a time below, ${suggestAltClause}.`;
    } else {
      closingBase = "Pick a time below.";
    }
    const closingParts = [closingBase];
    if (calendarPitch) closingParts.push(calendarPitch);
    const closing = closingParts.join(" ");

    const blocks: string[] = [openerLine];
    if (toneLine && !deferralFieldsList) blocks.push(toneLine);
    if (guestPickHint) blocks.push(guestPickHint);
    blocks.push(closing);
    return blocks.join("\n\n");
  },
};

// ─── Registry + resolver ─────────────────────────────────────────────────────

/**
 * The registry, exported as a const map for both lookup-by-key and
 * iteration. Order matches `GREETING_KEYS`; selection priority is
 * encoded in `selectGreeting`, NOT in this map's iteration order.
 */
export const GREETINGS: Record<GreetingKey, GreetingTemplate> = {
  "single-slot-lock": singleSlotLockTemplate,
  "recurring-meeting-anchor": recurringAnchorTemplate,
  "recurring-meeting-followup": recurringFollowupTemplate,
  anonymous: anonymousTemplate,
  proposal: proposalTemplate,
  "find-time": findTimeTemplate,
};

/**
 * Resolve which template renders this input. Priority:
 *   1. single-slot-lock      (most specific — exclusive + single slot override)
 *   2. recurring-followup    (recurring series, occurrenceIndex ≥ 1)
 *   3. recurring-anchor      (recurring series, first-slot pick — occurrenceIndex null)
 *   4. anonymous             (link.type=primary OR recurringWindowId != null)
 *   5. proposal              (named + has structural fields)
 *   6. find-time             (named + no structural fields — universal fallback)
 *
 * Recurring checks precede anonymous because an office-hours-with-series child
 * link is BOTH isAnonymousLink=true AND recurrence!=null — the recurring
 * templates take priority to surface the series framing.
 *
 * The resolver always returns a template — `find-time` is the final fallback
 * for any non-anonymous, non-recurring personalized link.
 */
export function selectGreeting(input: GreetingInput): GreetingTemplate {
  if (singleSlotLockTemplate.match(input)) return singleSlotLockTemplate;
  if (recurringFollowupTemplate.match(input)) return recurringFollowupTemplate;
  if (recurringAnchorTemplate.match(input)) return recurringAnchorTemplate;
  if (anonymousTemplate.match(input)) return anonymousTemplate;
  if (proposalTemplate.match(input)) return proposalTemplate;
  return findTimeTemplate;
}
