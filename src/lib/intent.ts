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
 *   — §4.8 exclusive cross-layer invariant (`exclusive` requires a score -2
 *     slotOverride; otherwise step down to `narrow`)
 *   — §4.9 misclassification cost asymmetry (open-side errors degrade
 *     gracefully; narrow-side errors produce the verbose-body failure mode
 *     that motivated this proposal).
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
 * Narrowing fields (any one of):
 *   - `preferredDays` present and non-empty
 *   - `preferredTimeStart` / `preferredTimeEnd` set (single contiguous window)
 *   - `preferredTimeWindows` present and non-empty (multi-window)
 *   - `dateRange` span < 5 calendar days (PR #57 threshold — wider is a
 *     bracket, not a narrowing)
 *   - `slotOverrides` present and non-empty (includes both -2 exclusive and
 *     -1 preferred)
 */
export function hasNarrowingField(rules: MaybeRules): boolean {
  if (!rules) return false;
  const preferredDays = rules.preferredDays;
  if (Array.isArray(preferredDays) && preferredDays.length > 0) return true;
  if (typeof rules.preferredTimeStart === "string" && rules.preferredTimeStart) return true;
  if (typeof rules.preferredTimeEnd === "string" && rules.preferredTimeEnd) return true;
  const ptw = rules.preferredTimeWindows;
  if (Array.isArray(ptw) && ptw.length > 0) return true;
  if (dateRangeSpanDays(rules) < 5) return true;
  const overrides = rules.slotOverrides;
  if (Array.isArray(overrides) && overrides.length > 0) return true;
  return false;
}

/**
 * Does the rules blob have at least one `slotOverrides` entry with the
 * exclusive-tier score (-2)? Enforces the §4.8 cross-layer invariant:
 * `exclusive` is a scoring-level semantic, not just a presentation label.
 */
export function hasExclusiveOverride(rules: MaybeRules): boolean {
  if (!rules) return false;
  const overrides = rules.slotOverrides;
  if (!Array.isArray(overrides)) return false;
  return overrides.some((o) => {
    if (!o || typeof o !== "object") return false;
    return (o as { score?: unknown }).score === -2;
  });
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
 * Material changes (any one of, prev → next):
 *   - dateRange collapsed from ≥ 5 days to < 5 days
 *   - preferredTimeStart or preferredTimeEnd added where neither was set
 *   - preferredTimeWindows added where none was set
 *   - preferredDays added where none was set
 *   - slotOverrides added with score -2 where none was set
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

  const prevTimeStart = typeof prev?.preferredTimeStart === "string" && prev.preferredTimeStart;
  const nextTimeStart = typeof next?.preferredTimeStart === "string" && next.preferredTimeStart;
  if (!prevTimeStart && nextTimeStart) return true;
  const prevTimeEnd = typeof prev?.preferredTimeEnd === "string" && prev.preferredTimeEnd;
  const nextTimeEnd = typeof next?.preferredTimeEnd === "string" && next.preferredTimeEnd;
  if (!prevTimeEnd && nextTimeEnd) return true;

  const prevPtw = Array.isArray(prev?.preferredTimeWindows) ? prev!.preferredTimeWindows : [];
  const nextPtw = Array.isArray(next?.preferredTimeWindows) ? next!.preferredTimeWindows : [];
  if (prevPtw.length === 0 && nextPtw.length > 0) return true;

  const prevDays = Array.isArray(prev?.preferredDays) ? prev!.preferredDays : [];
  const nextDays = Array.isArray(next?.preferredDays) ? next!.preferredDays : [];
  if (prevDays.length === 0 && nextDays.length > 0) return true;

  const prevHasExclusive = hasExclusiveOverride(prev);
  const nextHasExclusive = hasExclusiveOverride(next);
  if (!prevHasExclusive && nextHasExclusive) return true;

  return false;
}

/**
 * Read an already-stored intent blob off a `LinkRules` record and return
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
