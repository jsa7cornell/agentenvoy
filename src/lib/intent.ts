/**
 * Host-intent steering — captured at `create_link` time by the LLM and
 * consumed directly by the greeting renderer. Replaces the brittle
 * `hasMeaningfulSteering` predicate chain that reverse-engineers semantic
 * intent from field-shape inspection.
 *
 * Proposal: 2026-04-21_host-intent-capture-and-three-step-presentation
 *   — §4.1 four-tier enum
 *   — §4.6 asymmetric validator (step down, never step up)
 *   — §4.7 update-link split (LLM-driven edits always reclassify; direct-UI
 *     edits keep intent unless the rule shape materially narrowed)
 *   — §4.8 exclusive cross-layer invariant (`exclusive` requires a host-pinned
 *     exclusive slot; otherwise step down to `narrow`)
 *   — §4.9 misclassification cost asymmetry (open-side errors degrade
 *     gracefully; narrow-side errors produce the verbose-body failure mode
 *     that motivated this proposal).
 *
 * 2026-05-01 — narrowing-field detection rewritten to read the new
 * `availability.*` / `preferred.*` schema. The §4.8 exclusive invariant now
 * requires `availability.restrictToSlots.length > 0` (replacing the legacy
 * `slotOverrides[score=-2]` check). Per proposal
 * `2026-05-01_event-availability-vs-preferred-vs-calendar-scoring`.
 *
 * This module is pure (no I/O, no Prisma). Everything it reads comes in as
 * plain data so it can be unit-tested without the DB.
 */

/** Four-tier host-intent enum. */
export const STEERING_VALUES = [
  "open",
  "soft",
  "narrow",
  "exclusive",
] as const;

export type Steering = (typeof STEERING_VALUES)[number];

const STEERING_SET = new Set<string>(STEERING_VALUES);

/**
 * Coerce arbitrary input into a valid Steering value. Returns undefined for
 * missing / invalid — the default-to-`open` decision lives at the callsite
 * so the cost asymmetry (§4.9) is visible in context.
 */
export function normalizeSteering(input: unknown): Steering | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim().toLowerCase();
  return STEERING_SET.has(trimmed) ? (trimmed as Steering) : undefined;
}

type MaybeRules = Record<string, unknown> | null | undefined;

/**
 * Compute calendar-day span (inclusive) of a `{start, end}` date-range, in
 * whole days. Returns Infinity for malformed / missing — so callers treat
 * "unknown" as "wide" (does-not-narrow) which is the safe bias.
 */
export function dateRangeSpanDays(rules: MaybeRules): number {
  if (!rules) return Infinity;
  const dr = rules.dateRange as { start?: unknown; end?: unknown } | undefined;
  if (!dr || typeof dr.start !== "string" || typeof dr.end !== "string") {
    return Infinity;
  }
  const startMs = Date.parse(`${dr.start}T00:00:00Z`);
  const endMs = Date.parse(`${dr.end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return Infinity;
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

/**
 * Does the rules blob carry at least one field that genuinely narrows the
 * offer? Used by the §4.6 validator AND by `deriveLegacy` — we deliberately
 * use the same predicate so the shim's behavior matches "the LLM said
 * narrow and also set a narrowing field" exactly.
 *
 * Narrowing fields (any one of, per the 2026-05-01 schema rewrite):
 *   - `availability.restrictToDays` present and non-empty
 *   - `availability.restrictToWindows` present and non-empty
 *   - `availability.restrictToSlots` present and non-empty
 *   - `preferred.days` present and non-empty
 *   - `preferred.windows` present and non-empty
 *   - `preferred.slots` present and non-empty
 *   - `dateRange` span < 5 calendar days (wider is a bracket, not a narrowing)
 */
export function hasNarrowingField(rules: MaybeRules): boolean {
  if (!rules) return false;
  const availability = rules.availability as
    | {
        restrictToDays?: unknown;
        restrictToWindows?: unknown;
        restrictToSlots?: unknown;
      }
    | undefined;
  const restrictDays = availability?.restrictToDays;
  if (Array.isArray(restrictDays) && restrictDays.length > 0) return true;
  const restrictWindows = availability?.restrictToWindows;
  if (Array.isArray(restrictWindows) && restrictWindows.length > 0) return true;
  const restrictSlots = availability?.restrictToSlots;
  if (Array.isArray(restrictSlots) && restrictSlots.length > 0) return true;

  const preferred = rules.preferred as
    | { days?: unknown; windows?: unknown; slots?: unknown }
    | undefined;
  const prefDays = preferred?.days;
  if (Array.isArray(prefDays) && prefDays.length > 0) return true;
  const prefWindows = preferred?.windows;
  if (Array.isArray(prefWindows) && prefWindows.length > 0) return true;
  const prefSlots = preferred?.slots;
  if (Array.isArray(prefSlots) && prefSlots.length > 0) return true;

  if (dateRangeSpanDays(rules) < 5) return true;
  return false;
}

/**
 * Does the rules blob have at least one `availability.restrictToSlots`
 * entry? Enforces the §4.8 cross-layer invariant: `exclusive` is a
 * scoring-level semantic, not just a presentation label.
 *
 * 2026-05-01 — replaces the legacy `slotOverrides[score=-2]` check.
 */
export function hasExclusiveOverride(rules: MaybeRules): boolean {
  if (!rules) return false;
  const availability = rules.availability as
    | { restrictToSlots?: unknown }
    | undefined;
  const slots = availability?.restrictToSlots;
  return Array.isArray(slots) && slots.length > 0;
}

/**
 * Is this an `exclusive`-tier link that collapses to a single prescriptive
 * offer — exactly one `availability.restrictToSlots` entry?
 *
 * The greeting renderer uses this to skip the bulleted schedule body and
 * render a one-liner ("We're proposing X. Confirmation below."); the
 * calendar widget already highlights the single restricted slot as the offer.
 *
 * Deliberately permissive on other fields: dateRange / restrictToWindows
 * narrowing is EXPECTED for exclusive (they bracket the one slot), not
 * evidence of multiple alternatives.
 */
export function isSingleSlotExclusive(rules: MaybeRules): boolean {
  if (!rules) return false;
  const availability = rules.availability as
    | { restrictToSlots?: unknown }
    | undefined;
  const slots = availability?.restrictToSlots;
  if (!Array.isArray(slots)) return false;
  return slots.length === 1;
}

/**
 * §4.6 asymmetric validator. Called inside `handleCreateLink` (and whenever
 * an update triggers reclassification per §4.7). Steps DOWN when the LLM's
 * intent over-narrows the actual fields; never steps UP. This is the whole
 * shape of the §4.9 cost asymmetry: narrow-side errors are what produce
 * the bulleted-body-for-an-open-offer bug class that motivated the proposal.
 *
 *   - `intent=narrow` with no narrowing field        → step down to `soft`
 *   - `intent=exclusive` with no score-(-2) override → step down to `narrow`
 *   - `intent=open` / `intent=soft`                  → trust intent as-is
 *
 * Logs a warning on step-down so the classifier's drift is observable.
 * Returns the post-validation steering; callers persist this (not the raw
 * LLM emission).
 */
export function validateIntent(
  steering: Steering,
  rules: MaybeRules,
  ctx?: { linkCode?: string | null },
): Steering {
  const codeLabel = ctx?.linkCode ?? "new";

  if (steering === "exclusive" && !hasExclusiveOverride(rules)) {
    console.warn(
      `[intent] step-down exclusive → narrow: no slotOverrides[score=-2] (linkCode=${codeLabel})`,
    );
    // Recurse once so the narrow→soft step-down below also runs if the
    // fields don't support `narrow` either.
    return validateIntent("narrow", rules, ctx);
  }

  if (steering === "narrow" && !hasNarrowingField(rules)) {
    console.warn(
      `[intent] step-down narrow → soft: no narrowing field present (linkCode=${codeLabel})`,
    );
    return "soft";
  }

  return steering;
}

/**
 * Back-compat shim for links created before intent capture shipped. Applies
 * the pre-existing `hasMeaningfulSteering` predicate (syntactic inspection)
 * to produce a best-guess tier. Deliberately NOT deleted in this PR — per
 * §4.10 the delete trigger is telemetry-based (`legacyFallbackRate < 1%`
 * for 7 consecutive days).
 *
 * Two-step derivation:
 *   1. If `slotOverrides` includes a score -2 entry → `exclusive`
 *   2. Else if any narrowing field is set → `narrow`
 *   3. Else → `open`
 *
 * Note: `soft` is unreachable from the legacy predicate — the predicate
 * never distinguished "preference with fallback" from "plain narrowing."
 * That's fine: the cost asymmetry (§4.9) says errors that round toward
 * narrow are worse than errors that round toward open, and this shim
 * errs away from narrow whenever it can.
 */
export function deriveLegacy(rules: MaybeRules): Steering {
  if (hasExclusiveOverride(rules)) return "exclusive";
  if (hasNarrowingField(rules)) return "narrow";
  return "open";
}

/**
 * §4.7 split rule — "is this direct-UI edit material enough to force a
 * reclassification?". LLM-driven edits always reclassify (the caller
 * doesn't use this helper); direct-UI edits keep the prior intent UNLESS
 * one of the material thresholds below trips.
 *
 * Material changes (any one of, prev → next, per the 2026-05-01 schema):
 *   - dateRange collapsed from ≥ 5 days to < 5 days
 *   - `availability.restrictToDays` added where none was set
 *   - `availability.restrictToWindows` added where none was set
 *   - `availability.restrictToSlots` added where none was set (the new
 *     §4.8 exclusive trigger)
 *   - `preferred.days` added where none was set
 *   - `preferred.windows` added where none was set
 *   - `preferred.slots` added where none was set
 *
 * Returning `true` means the caller should re-run the classifier (or, for
 * non-LLM code paths, apply `deriveLegacy` + `validateIntent`). Returning
 * `false` means keep the prior intent as-is.
 */
export function hasMaterialNarrowingChange(
  prev: MaybeRules,
  next: MaybeRules,
): boolean {
  const prevSpan = dateRangeSpanDays(prev);
  const nextSpan = dateRangeSpanDays(next);
  if (prevSpan >= 5 && nextSpan < 5) return true;

  const addedNonEmpty = (
    prevPath: unknown,
    nextPath: unknown,
  ): boolean => {
    const prevArr = Array.isArray(prevPath) ? prevPath : [];
    const nextArr = Array.isArray(nextPath) ? nextPath : [];
    return prevArr.length === 0 && nextArr.length > 0;
  };

  const prevAvail = (prev?.availability ?? {}) as Record<string, unknown>;
  const nextAvail = (next?.availability ?? {}) as Record<string, unknown>;
  if (addedNonEmpty(prevAvail.restrictToDays, nextAvail.restrictToDays)) return true;
  if (addedNonEmpty(prevAvail.restrictToWindows, nextAvail.restrictToWindows)) return true;
  if (addedNonEmpty(prevAvail.restrictToSlots, nextAvail.restrictToSlots)) return true;

  const prevPref = (prev?.preferred ?? {}) as Record<string, unknown>;
  const nextPref = (next?.preferred ?? {}) as Record<string, unknown>;
  if (addedNonEmpty(prevPref.days, nextPref.days)) return true;
  if (addedNonEmpty(prevPref.windows, nextPref.windows)) return true;
  if (addedNonEmpty(prevPref.slots, nextPref.slots)) return true;

  return false;
}

/**
 * Read an already-stored intent blob off a `LinkParameters` record and return
 * the resolved steering. Returns `null` if the rules don't carry an intent
 * field (caller falls back to `deriveLegacy`).
 */
export function readStoredSteering(rules: MaybeRules): Steering | null {
  if (!rules || typeof rules !== "object") return null;
  const intent = (rules as { intent?: unknown }).intent;
  if (!intent || typeof intent !== "object") return null;
  const steering = (intent as { steering?: unknown }).steering;
  return normalizeSteering(steering) ?? null;
}

// ---------------------------------------------------------------------------
// Chat-turn intent (split-pass router)
//
// Proposal: 2026-04-21_dashboard-chat-intent-router (decided 2026-04-21 pm).
//
// Extends PR #58's closed-enum classifier pattern one layer up: classifies
// the *turn-level intent* of a host's utterance into a 5-tier enum. The
// classifier runs as a dedicated Haiku call ahead of the scheduling pass —
// NOT inline with scheduling. See §1.3 of the proposal for why (256-line
// channel.md too dense to absorb a second classifier).
//
// Phase 5 PR 3 (CODEBASE-CLEANUP §10): extended with `HOST_CHAT_INTENT_VALUES`
// — the host-side enum the role-aware classifier (PR 4) and composer
// convergence (PR 5) will switch on. Today's classifier schema is still
// constrained to the guest tuple; the host extension is forward-only data
// structure so downstream consumers can take a dependency without further
// enum churn.
// ---------------------------------------------------------------------------

export const CHAT_INTENT_VALUES = [
  "schedule",
  "profile",
  "rule",
  "inquire",
  "unclear",
  "chitchat",
] as const;

/**
 * Host-side chat intents (per 2026-04-27 chat-decisioning-layer-redesign
 * proposal, §2.2/§2.3 — closed enum protected by PLAYBOOK Rule 19d).
 *
 * Emitted by the role-aware classifier when the dashboard chat composer
 * receives a host message. The 7-value enum splits the legacy `schedule`
 * intent into three event-shaped variants so the matcher stops guessing
 * between create-vs-modify-vs-cancel via the marco template (the root
 * cause of Bugs #4 and #5 in the 2026-04-27 cascade).
 *
 *   - `edit_preference`  — host wants to update Preferences (working hours,
 *                          default duration, default format, etc.).
 *   - `create_link`      — host wants to create a NEW reusable / one-off link.
 *                          Creation verbs: "make/create/set up/book/schedule/
 *                          grab/find time/I need a link".
 *   - `modify_link`      — host wants to change an EXISTING link/session.
 *                          Modification verbs: "change/move/shift/reschedule/
 *                          update the [existing X]".
 *   - `cancel_link`      — host wants to remove an EXISTING link/session.
 *                          Cancellation verbs: "cancel/remove/drop/delete the
 *                          [existing X]".
 *   - `query_calendar`   — host wants to know what's on their calendar.
 *   - `query_event`      — host wants details on a specific upcoming event.
 *   - `chat`             — neutral host chitchat / catch-all routed back to
 *                          the composer for free-form response.
 *
 * Per §2.3 R1 verification: when create-vs-modify is ambiguous (single
 * existing match for the named guest), the classifier defaults to
 * `create_link`. `handleCreateLink` is reversible-without-side-effects
 * pre-confirm (DB rows only, no email/calendar/notification).
 */
export const HOST_CHAT_INTENT_VALUES = [
  "edit_preference",
  "create_link",
  "modify_link",
  "cancel_link",
  "query_calendar",
  "query_event",
  "chat",
] as const;

export type GuestChatIntent = (typeof CHAT_INTENT_VALUES)[number];
export type HostChatIntent = (typeof HOST_CHAT_INTENT_VALUES)[number];
export type ChatIntent = GuestChatIntent | HostChatIntent;

const CHAT_INTENT_SET = new Set<string>([
  ...CHAT_INTENT_VALUES,
  ...HOST_CHAT_INTENT_VALUES,
]);
const GUEST_CHAT_INTENT_SET = new Set<string>(CHAT_INTENT_VALUES);
const HOST_CHAT_INTENT_SET = new Set<string>(HOST_CHAT_INTENT_VALUES);

/**
 * Quick-reply shape emitted by the classifier when `kind === "unclear"`.
 * Per N2 fold: stub tiers are NOT allowed as quick-reply targets in v1 —
 * clicking a profile/rule option would dead-end on a "coming soon" stub.
 * The schema enumerates `["schedule", "inquire"]` only.
 */
export type ChatIntentQuickReply = {
  label: string;
  intent: "schedule" | "inquire";
};

export type ChatIntentBlock = {
  kind: ChatIntent;
  /** Rendered verbatim as the clarifier turn when kind = "unclear". Ignored
   *  for other kinds. */
  clarifier?: string;
  quickReplies?: ChatIntentQuickReply[];
  /** Single emoji for kind = "chitchat". Placed as a reaction on the host's
   *  message bubble (WhatsApp-style). */
  emoji?: string;
};

/**
 * Coerce unknown input (Haiku tool-use output, `userIntentHint` from POST,
 * client-emitted hint, etc.) into a valid ChatIntent. Returns the tier
 * string if valid for either role, else null.
 *
 * For role-specific narrowing use `normalizeGuestChatIntent` /
 * `normalizeHostChatIntent`.
 */
export function normalizeChatIntent(input: unknown): ChatIntent | null {
  if (typeof input !== "string") return null;
  return CHAT_INTENT_SET.has(input) ? (input as ChatIntent) : null;
}

/**
 * Role-narrowed normalizer — returns the value only if it's in the guest
 * subset. Used by code paths where a host intent would be a category error
 * (e.g., the guest-side classifier validator).
 */
export function normalizeGuestChatIntent(input: unknown): GuestChatIntent | null {
  if (typeof input !== "string") return null;
  return GUEST_CHAT_INTENT_SET.has(input) ? (input as GuestChatIntent) : null;
}

/**
 * Role-narrowed normalizer — returns the value only if it's in the host
 * subset. Used by code paths where a guest intent would be a category error
 * (e.g., the host-side classifier in PR 4).
 */
export function normalizeHostChatIntent(input: unknown): HostChatIntent | null {
  if (typeof input !== "string") return null;
  return HOST_CHAT_INTENT_SET.has(input) ? (input as HostChatIntent) : null;
}

/**
 * Validate a raw classifier block. Schema-forced by the API boundary, so
 * this is defense-in-depth — a malformed tool-use response is a
 * provider-contract failure, not semantic ambiguity.
 *
 * Semantic ambiguity (§1.5 "WHEN IN DOUBT PICK unclear") lives in the
 * classifier playbook prompt; this validator handles structural edge
 * cases only:
 *   - missing/invalid `kind` → `unclear` with generic clarifier text
 *   - `kind === "unclear"` but no clarifier text → `schedule` (matches
 *     today's behavior; avoids a dead-end empty clarifier bubble)
 *   - quick-replies with invalid/stub-tier intent → dropped
 *
 * Phase 5 PR 3 (CODEBASE-CLEANUP §10): host-side intents added in
 * `HOST_CHAT_INTENT_VALUES` fall through the default `return { kind }`
 * branch by design. The chitchat/unclear special cases are guest-only.
 * PR 4 will introduce a host-specific validator when the role-aware
 * classifier ships.
 */
export function validateChatIntent(raw: unknown): ChatIntentBlock {
  if (!raw || typeof raw !== "object") {
    return { kind: "unclear", clarifier: GENERIC_CLARIFIER };
  }
  const block = raw as {
    kind?: unknown;
    clarifier?: unknown;
    quickReplies?: unknown;
    emoji?: unknown;
  };
  const kind = normalizeChatIntent(block.kind);
  if (!kind) {
    return { kind: "unclear", clarifier: GENERIC_CLARIFIER };
  }

  if (kind === "chitchat") {
    const emoji =
      typeof block.emoji === "string" && block.emoji.trim()
        ? block.emoji.trim()
        : "👍";
    return { kind, emoji };
  }

  if (kind === "unclear") {
    const clarifier =
      typeof block.clarifier === "string" && block.clarifier.trim()
        ? block.clarifier.trim()
        : null;
    // Unclear without clarifier text = dead-end bubble. Fall back to
    // schedule (today's behavior) rather than render an empty prompt.
    if (!clarifier) return { kind: "schedule" };

    const quickReplies = Array.isArray(block.quickReplies)
      ? block.quickReplies
          .map((q) => {
            if (!q || typeof q !== "object") return null;
            const item = q as { label?: unknown; intent?: unknown };
            const label = typeof item.label === "string" ? item.label.trim() : "";
            const intent = normalizeChatIntent(item.intent);
            // Stub tiers (profile, rule) dropped per N2 — no dead-end CTAs.
            if (!label || !intent || (intent !== "schedule" && intent !== "inquire")) {
              return null;
            }
            return { label, intent } as ChatIntentQuickReply;
          })
          .filter((x): x is ChatIntentQuickReply => x !== null)
          .slice(0, 3)
      : [];

    return { kind, clarifier, quickReplies };
  }

  return { kind };
}

const GENERIC_CLARIFIER =
  "I'm not sure what you're asking — could you clarify?";
