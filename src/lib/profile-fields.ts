/**
 * Canonical read/write path for profile fields that may live in either
 * `preferences.<key>` (legacy top-level) or `preferences.explicit.<key>`
 * (post-2026-04-21 canonical). Proposal 3 ("Progressive Profiling",
 * decided 2026-04-21) picks `explicit.*` as the canonical home and
 * introduces these helpers so every reader/writer goes through one
 * path.
 *
 * Rules:
 *   - `readProfileField(prefs, key)` — `explicit.<key>` wins, falls back to
 *     top-level for legacy rows. This absorbs the two-tier split until
 *     legacy top-level values decay to zero reads (target ~30 days).
 *   - `writeProfileField(prefs, key, value)` — ALWAYS writes under
 *     `explicit.<key>`. Returns the updated preferences object; callers
 *     persist it. Also clears any legacy top-level copy of the same field
 *     so the helper never needs to read both tiers again for this row.
 *
 * Write-side enforcement: the ESLint `no-restricted-syntax` rule in
 * `.eslintrc.json` forbids direct top-level writes to the tracked keys
 * outside this file. New code must go through `writeProfileField`.
 */

import type { UserPreferences } from "./scoring";

/**
 * Fields that live under `explicit.*` as canonical but may also appear at
 * the top level on legacy rows. Keep this list in lockstep with the
 * ESLint `no-restricted-syntax` rule in `.eslintrc.json` — if you add a
 * key here, update the lint rule too (and vice versa).
 */
export type ProfileFieldKey =
  | "phone"
  | "videoProvider"
  | "zoomLink"
  | "defaultDuration"
  | "format"
  | "timezone"
  | "themeMode";

type ExplicitPrefs = NonNullable<UserPreferences["explicit"]>;

// Concrete value type for each tracked key — inferred from the explicit
// tier's types on UserPreferences so readers get the right narrowed type.
type ProfileFieldValue<K extends ProfileFieldKey> = K extends keyof ExplicitPrefs
  ? ExplicitPrefs[K]
  : never;

/**
 * Read a profile field. Prefers `preferences.explicit.<key>`; falls back
 * to `preferences.<key>` for legacy rows. Returns `undefined` when the
 * field is absent in both tiers (including when `prefs` is null).
 */
export function readProfileField<K extends ProfileFieldKey>(
  prefs: UserPreferences | null | undefined,
  key: K,
): ProfileFieldValue<K> | undefined {
  if (!prefs) return undefined;
  const fromExplicit = prefs.explicit?.[key];
  if (fromExplicit !== undefined) return fromExplicit as ProfileFieldValue<K>;
  const topLevel = (prefs as Record<string, unknown>)[key];
  return (topLevel === undefined ? undefined : topLevel) as
    | ProfileFieldValue<K>
    | undefined;
}

/**
 * Write a profile field. Always lands the write under `explicit.<key>`;
 * also deletes any legacy top-level copy of the same key so readers
 * don't see drift. Pure function — returns a new preferences object;
 * caller persists it.
 *
 * Passing `undefined` clears the field from `explicit` AND strips the
 * legacy top-level copy. Distinguish from "no change" by not calling
 * this helper at all.
 */
export function writeProfileField<K extends ProfileFieldKey>(
  prefs: UserPreferences | null | undefined,
  key: K,
  value: ProfileFieldValue<K> | undefined,
): UserPreferences {
  const base: UserPreferences = prefs ? { ...prefs } : {};
  const nextExplicit: ExplicitPrefs = { ...(base.explicit ?? {}) };
  if (value === undefined) {
    delete (nextExplicit as Record<string, unknown>)[key];
  } else {
    (nextExplicit as Record<string, unknown>)[key] = value;
  }
  base.explicit = nextExplicit;
  // Strip legacy top-level copy — canonicalize on write.
  delete (base as Record<string, unknown>)[key];
  return base;
}
