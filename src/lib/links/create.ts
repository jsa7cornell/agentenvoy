/**
 * Variance-link creation primitives.
 *
 * `snapshotPostureFromUser(user)` returns a complete `LinkParameters`
 * posture blob from the host's current Primary state. New variance
 * links seed from this snapshot at create time, then apply the host's
 * create-time edits on top. From that moment, the variance lives
 * independently of `User.preferences` (parent proposal §2.2 hardcoded
 * model).
 *
 * `applyCreateEdits(snapshot, edits)` merges create-time edits into a
 * snapshot using presence-based semantics (`key in obj`) so explicit
 * `0` and `[]` values are preserved, not silently overwritten.
 *
 * Decision references:
 *  - `proposals/2026-05-02_per-link-config-storage-and-scoring-link-scope_*`
 *    §2.3 (variance-create snapshot path), §2.4 (presence-based merge)
 *  - `proposals/2026-05-02_primary-as-posture-and-reusable-link-propagation_*`
 *    §2.2 (every variance stores its own complete config)
 */

import type { ParsedLinkParameters } from "../link-parameters";
import type { UserPreferences } from "../scoring";
import type { ResolvedPosture } from "./posture";

/** Subset of `LinkParameters` that carries posture state. Matches the
 *  V1.5 schema additions in `link-parameters.ts`. */
export type PostureSnapshot = Pick<
  ParsedLinkParameters,
  | "hoursStartMinutes"
  | "hoursEndMinutes"
  | "daysOfWeek"
  | "duration"
  | "bufferMinutes"
  | "format"
  | "eveningsPosture"
  | "compiled"
>;

const DEFAULT_DAYS_OF_WEEK = [1, 2, 3, 4, 5]; // Mon–Fri
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_BUFFER_MINUTES = 0;
const DEFAULT_FORMAT = "video";
const DEFAULT_EVENINGS_POSTURE: ResolvedPosture["eveningsPosture"] = "protected";
const DEFAULT_HOURS_START_MINUTES = 9 * 60;
const DEFAULT_HOURS_END_MINUTES = 18 * 60;

/** Snapshot the host's current Primary posture as a complete
 *  `PostureSnapshot` suitable for embedding in `link.parameters` at
 *  variance-create time.
 *
 *  Reads `User.preferences.explicit.*` and `User.preferences.compiled.*`
 *  with the same scalar-mapping logic `getLinkPosture` uses for Primary.
 *  Defaults fill any field the user hasn't set yet (Mon–Fri, 9–18,
 *  30 min, 0 buffer, video).
 */
export function snapshotPostureFromUser(user: {
  preferences?: UserPreferences | null;
}): PostureSnapshot {
  const prefs = user.preferences ?? {};
  const explicit = prefs.explicit ?? {};
  const compiledRaw = (prefs as { compiled?: unknown }).compiled;
  const compiled =
    compiledRaw && typeof compiledRaw === "object"
      ? (compiledRaw as Record<string, unknown>)
      : null;

  const hoursStartMinutes =
    explicit.businessHoursStartMinutes ??
    (typeof explicit.businessHoursStart === "number"
      ? explicit.businessHoursStart * 60
      : DEFAULT_HOURS_START_MINUTES);
  const hoursEndMinutes =
    explicit.businessHoursEndMinutes ??
    (typeof explicit.businessHoursEnd === "number"
      ? explicit.businessHoursEnd * 60
      : DEFAULT_HOURS_END_MINUTES);

  return {
    hoursStartMinutes,
    hoursEndMinutes,
    daysOfWeek: DEFAULT_DAYS_OF_WEEK,
    duration: explicit.defaultDuration ?? DEFAULT_DURATION_MINUTES,
    bufferMinutes: explicit.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
    format: DEFAULT_FORMAT,
    eveningsPosture: DEFAULT_EVENINGS_POSTURE,
    compiled: compiled
      ? {
          buffers: (compiled.buffers as PostureSnapshot["compiled"] extends infer T ? T : never) ?? [],
          priorityBuckets: (compiled.priorityBuckets as PostureSnapshot["compiled"] extends infer T ? T : never) ?? [],
          allowWindows: (compiled.allowWindows as PostureSnapshot["compiled"] extends infer T ? T : never) ?? [],
          ambiguities: (compiled.ambiguities as PostureSnapshot["compiled"] extends infer T ? T : never) ?? [],
        } as PostureSnapshot["compiled"]
      : { buffers: [], priorityBuckets: [], allowWindows: [], ambiguities: [] },
  };
}

/** Merge create-time edits into a posture snapshot using presence-based
 *  semantics — `key in edits` triggers replacement, even when the edit
 *  value is `0`, `""`, or `[]`. Preserves explicit user choices that
 *  truthy/`??` checks would silently drop.
 */
export function applyCreateEdits(
  snapshot: PostureSnapshot,
  edits: Partial<PostureSnapshot>
): PostureSnapshot {
  const result: PostureSnapshot = { ...snapshot };
  if ("hoursStartMinutes" in edits) result.hoursStartMinutes = edits.hoursStartMinutes;
  if ("hoursEndMinutes" in edits) result.hoursEndMinutes = edits.hoursEndMinutes;
  if ("daysOfWeek" in edits) result.daysOfWeek = edits.daysOfWeek;
  if ("duration" in edits) result.duration = edits.duration;
  if ("bufferMinutes" in edits) result.bufferMinutes = edits.bufferMinutes;
  if ("format" in edits) result.format = edits.format;
  if ("eveningsPosture" in edits) result.eveningsPosture = edits.eveningsPosture;
  if ("compiled" in edits) result.compiled = edits.compiled;
  return result;
}
