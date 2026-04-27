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
 *
 * Anonymous voice fires on the primary link AND on reusables backed by a
 * recurring window (Office-Hours-style). All other reusable variants and
 * single-use links use personalized voice. See [SPEC-2.0.md §2.5.4 + §3.6].
 */

import { formatDuration } from "@/lib/format-duration";
import { formatLabel } from "@/lib/greeting-template";
import { isSingleSlotExclusive } from "@/lib/intent";
import type { Steering } from "@/lib/intent";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Stable identifier for each template variant. The wire response does not
 * surface this key; it's purely a registry-internal handle for selection
 * and tests.
 */
export const GREETING_KEYS = [
  "single-slot-lock",
  "anonymous",
  "proposal",
  "find-time",
] as const;

export type GreetingKey = (typeof GREETING_KEYS)[number];

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

  /** Sanitized link-rules blob (the `link.rules` JSON column). */
  linkRules: Record<string, unknown>;

  /** True iff `link.type === "primary" || !!link.recurringWindowId`. */
  isAnonymousLink: boolean;
  /** True iff `link.recurringWindowId != null`. Office-hours children only. */
  isOfficeHoursLink: boolean;

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
   * "Let me know where works for you[ — John suggested Central Park]." or null.
   * Pre-built so the registry renderer doesn't repeat the suggestion-format
   * logic inline. Fed into proposal/find-time branches only.
   */
  guestPickHint: string | null;

  /**
   * Dimension-aware suggest-alt clause. Pre-built so the registry doesn't
   * need to know which dimensions the host set. Null when:
   *   - steering is narrow/exclusive, or
   *   - this is an office-hours link, or
   *   - neither format nor duration is set.
   */
  suggestAltClause: string | null;

  /**
   * Calendar-connect pitch ("…if you connect your calendar I can…"). Shown
   * only when `bookableSlotCount > 1 && !isGuest`. Null otherwise.
   */
  calendarPitch: string | null;

  /** Sanitized host tone string from guidance, surfaced verbatim. May be null. */
  toneLine: string | null;
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
      const overrides = (linkRules?.slotOverrides ?? []) as Array<{
        start?: unknown;
        score?: unknown;
      }>;
      const hit = overrides.find(
        (o) => typeof o.start === "string" && o.score === -2,
      );
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

// ─── Branch C: anonymous-visitor voice ───────────────────────────────────────

/**
 * "👋 I'm {Host}'s scheduling agent.\n{body}"
 *
 * Fires on the primary link OR an Office-Hours-style child link
 * (`recurringWindowId != null`). Office-hours surface `topic` inline; bare
 * primaries fall back to the default-format pitch.
 */
const anonymousTemplate: GreetingTemplate = {
  key: "anonymous",
  description:
    "Agent-voice self-intro for anonymous visitors. Fires on type=primary " +
    "and on reusables backed by a recurring window (Office Hours).",
  match: (input) => input.isAnonymousLink,
  render: (input) => {
    const { hostFirstName, isOfficeHoursLink, rawTopic, meetingDescShort, calendarPitch } = input;
    // Office-hours children carry a `topic` (e.g. "Coaching hours"). Bare
    // primary links don't — render the default offer instead.
    const hostTopic =
      isOfficeHoursLink && rawTopic ? rawTopic : null;
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
    const { greeteeName, hostFirstName, toneLine, guestPickHint, suggestAltClause, calendarPitch } = input;
    const withClause = buildWithClause(input);
    const proposalPhrase = buildProposalPhrase(input);
    const openerLine = `👋 ${greeteeName}! I'm scheduling time ${withClause}. ${hostFirstName} is proposing ${proposalPhrase}.`;

    const closingBase = suggestAltClause
      ? `Pick a time below, ${suggestAltClause}.`
      : "Pick a time below.";
    const closingParts = [closingBase];
    if (calendarPitch) closingParts.push(calendarPitch);
    const closing = closingParts.join(" ");

    const blocks: string[] = [openerLine];
    if (toneLine) blocks.push(toneLine);
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
    const { greeteeName, hostFirstName, timingLabel, toneLine, guestPickHint, suggestAltClause, calendarPitch } = input;
    const findTimeWithClause = buildFindTimeWithClause(input);
    const openerLine = `👋 ${greeteeName}! ${hostFirstName} asked me to find time${findTimeWithClause}${timingLabel ? ` ${timingLabel}` : ""}.`;

    const closingBase = suggestAltClause
      ? `Pick a time below, ${suggestAltClause}.`
      : "Pick a time below.";
    const closingParts = [closingBase];
    if (calendarPitch) closingParts.push(calendarPitch);
    const closing = closingParts.join(" ");

    const blocks: string[] = [openerLine];
    if (toneLine) blocks.push(toneLine);
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
  anonymous: anonymousTemplate,
  proposal: proposalTemplate,
  "find-time": findTimeTemplate,
};

/**
 * Resolve which template renders this input. Priority:
 *   1. single-slot-lock (most specific — exclusive + single override)
 *   2. anonymous (link.type / recurringWindowId)
 *   3. proposal (named + has structural fields)
 *   4. find-time (named + no structural fields — final fallback)
 *
 * The resolver always returns a template — `find-time` is the universal
 * fallback for any non-anonymous personalized link.
 */
export function selectGreeting(input: GreetingInput): GreetingTemplate {
  if (singleSlotLockTemplate.match(input)) return singleSlotLockTemplate;
  if (anonymousTemplate.match(input)) return anonymousTemplate;
  if (proposalTemplate.match(input)) return proposalTemplate;
  return findTimeTemplate;
}
