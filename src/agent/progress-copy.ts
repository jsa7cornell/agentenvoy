/**
 * Progress-narration copy registry + selection helpers.
 *
 * Emits "status frames" during channel-chat turns (see
 * `src/app/api/channel/chat/route.ts`) — calendar-native reasoning commentary
 * that fills the spinner gap while Envoy moves through pipeline stages.
 *
 * See proposal:
 *   proposals/2026-04-21_envoy-progress-reasoning-narration_reviewed-2026-04-21_decided-2026-04-21.md
 *
 * PII CONTRACT (§2.2 N5 fold): `ProgressCopySlot` is a CLOSED TypeScript
 * union. Adding a `{preference}` or `{directive}` is a type-system change,
 * not a convention change — a contributor who tries to add one gets a
 * compile error, not a PR review question. This is the guard that keeps
 * learnings / directives / host-only context out of progress frames.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Closed slot set — THIS IS THE PII CONTRACT. Do not widen. */
export type ProgressCopySlot = "day" | "guest" | "count" | "tz";

/** A template string containing zero or more `{slot}` placeholders from the closed union. */
export type ProgressCopyTemplate = string;

/** Values for slot interpolation. Any slot not supplied causes the template to be skipped. */
export type ProgressCopyInterpolation = Partial<Record<ProgressCopySlot, string>>;

/** Pipeline stages that can emit status frames. See §2.1. */
export type ProgressStage =
  | "scanning-calendar"
  | "scoring"
  | "thinking"
  | "drafting"
  | "executing"
  | "finalizing"
  | "retrying";

/** Known action kinds for per-action sub-variants under `"executing"`. Matches `actions.ts`. */
export type ProgressExecutingAction =
  | "create_link"
  | "update_link"
  | "update_time"
  | "update_format"
  | "update_location"
  | "expand_link"
  | "cancel"
  | "hold_slot"
  | "release_hold"
  | "archive"
  | "archive_bulk"
  | "unarchive"
  | "update_knowledge"
  | "update_meeting_settings"
  | "save_guest_info";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const SIMPLE_STAGES = [
  "scanning-calendar",
  "scoring",
  "thinking",
  "drafting",
  "finalizing",
  "retrying",
] as const;

type SimpleStage = (typeof SIMPLE_STAGES)[number];

const SIMPLE_COPY: Record<SimpleStage, readonly ProgressCopyTemplate[]> = {
  "scanning-calendar": [
    "Reading your week\u2026",
    "Flipping through your calendar\u2026",
    "Pulling up your availability\u2026",
    "Checking what you\u2019ve got on\u2026",
  ],
  "scoring": [
    "Scoring slots across the next 2 weeks\u2026",
    "Weighing your preferences against open windows\u2026",
    "Checking what lines up\u2026",
    "Scoring {day} against your preferences\u2026",
    "Triangulating with {guest}\u2019s time zone\u2026",
    "Ranking {count} candidate slots\u2026",
  ],
  "thinking": [
    "Thinking it through\u2026",
    "Weighing morning vs. afternoon\u2026",
    "Cross-checking your directives\u2026",
    "Holding the options up to your context\u2026",
    "Hmm, one sec\u2026",
  ],
  "drafting": [
    "Drafting the invite\u2026",
    "Drafting the link for {guest}\u2026",
    "Shaping the offer\u2026",
  ],
  "finalizing": [
    "Almost there\u2026",
    "Wrapping up\u2026",
    "Tying the bow\u2026",
  ],
  "retrying": [
    "Let me try that again\u2026",
    "One more pass\u2026",
  ],
};

const EXECUTING_COPY: Record<ProgressExecutingAction, readonly ProgressCopyTemplate[]> = {
  create_link: ["Drafting the link for {guest}\u2026", "Shaping {guest}\u2019s invite\u2026"],
  update_link: ["Updating {guest}\u2019s link\u2026", "Shifting the offer\u2026"],
  update_time: ["Moving the meeting to {day}\u2026", "Shifting to {day}\u2026"],
  update_format: ["Adjusting the meeting format\u2026"],
  update_location: ["Updating the location\u2026"],
  expand_link: ["Opening up more times for {guest}\u2026", "Expanding the window\u2026"],
  cancel: ["Cancelling with {guest}\u2026", "Closing this out\u2026"],
  hold_slot: ["Holding a slot for {guest}\u2026"],
  release_hold: ["Releasing the hold\u2026"],
  archive: ["Filing this away\u2026"],
  archive_bulk: ["Tidying your feed\u2026"],
  unarchive: ["Bringing it back\u2026"],
  update_knowledge: ["Jotting that down\u2026"],
  update_meeting_settings: ["Updating your meeting defaults\u2026"],
  save_guest_info: ["Saving what I learned about {guest}\u2026", "Noting {guest}\u2019s details\u2026"],
};

const EXECUTING_GENERIC: readonly ProgressCopyTemplate[] = [
  "Working on it\u2026",
  "Running that now\u2026",
];

// Exported for tests.
export const PROGRESS_COPY = {
  ...SIMPLE_COPY,
  executing: EXECUTING_COPY,
} as const;

// ---------------------------------------------------------------------------
// Slot interpolation
// ---------------------------------------------------------------------------

const SLOT_NAMES: readonly ProgressCopySlot[] = ["day", "guest", "count", "tz"];
const SLOT_REGEX = /\{(day|guest|count|tz)\}/g;

/** Returns the list of slot names referenced by `template`. */
export function templateSlots(template: ProgressCopyTemplate): ProgressCopySlot[] {
  const out: ProgressCopySlot[] = [];
  const seen = new Set<ProgressCopySlot>();
  let m: RegExpExecArray | null;
  const re = new RegExp(SLOT_REGEX.source, SLOT_REGEX.flags);
  while ((m = re.exec(template)) !== null) {
    const name = m[1] as ProgressCopySlot;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Fill the slots in `template` from `values`. Returns `null` if the template
 * references a slot missing from `values` — caller falls back to a slotless
 * variant in that case.
 */
export function fillTemplate(
  template: ProgressCopyTemplate,
  values: ProgressCopyInterpolation,
): string | null {
  const needed = templateSlots(template);
  for (const slot of needed) {
    if (!values[slot]) return null;
  }
  return template.replace(SLOT_REGEX, (_match, slot: string) => {
    // Safe — regex only matches closed-union slot names.
    return values[slot as ProgressCopySlot] ?? "";
  });
}

// ---------------------------------------------------------------------------
// Variant selection
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-bit hash of a string (DJB2 variant). Used as a rotation
 * seed so tests can pin a userId + turn index and get a stable variant.
 */
function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export interface SelectVariantArgs {
  stage: ProgressStage;
  /** Action kind — required when stage === "executing" to pick the sub-variant list. */
  action?: ProgressExecutingAction;
  /** Slot values. Templates that reference missing slots are skipped. */
  slots?: ProgressCopyInterpolation;
  /** Seed components: userId + turn-index-within-chat-thread (§2.2 selection rules). */
  userId: string;
  turnIndex: number;
  /**
   * Which emission-within-the-turn this is (0-based). Used for within-stage
   * rotation (§2.2 R2 fold) and also to avoid repeating the same variant
   * within a turn.
   */
  withinStageIndex?: number;
  /** Variant indices already rendered this turn — skip these to avoid repeats. */
  usedIndices?: ReadonlySet<number>;
}

export interface SelectedVariant {
  /** The filled string ready to display. */
  copy: string;
  /** Index into the underlying template array — exposed for dedup across frames. */
  index: number;
  /** Whether the chosen template used any slot interpolation. */
  slotted: boolean;
}

function variantsFor(stage: ProgressStage, action?: ProgressExecutingAction): readonly ProgressCopyTemplate[] {
  if (stage === "executing") {
    if (action && EXECUTING_COPY[action]) return EXECUTING_COPY[action];
    return EXECUTING_GENERIC;
  }
  return SIMPLE_COPY[stage];
}

/**
 * Pick a variant for a stage. Prefers slotted templates when slot data is
 * available (§2.2 "Template-with-slots wins when the slot can be filled").
 * Rotation is seeded by `userId + turnIndex + withinStageIndex` so the same
 * user sees a different variant from turn to turn but tests pin deterministic.
 *
 * Returns `null` if the stage has no variants (should be impossible given the
 * registry).
 */
export function selectVariant(args: SelectVariantArgs): SelectedVariant | null {
  const { stage, action, slots, userId, turnIndex, withinStageIndex = 0, usedIndices } = args;
  const pool = variantsFor(stage, action);
  if (pool.length === 0) return null;

  const seed = hashSeed(`${userId}|${turnIndex}|${stage}|${action ?? ""}|${withinStageIndex}`);

  // Partition: slotted templates whose slots we can fill, vs slotless templates.
  const fillable: Array<{ idx: number; copy: string; slotted: boolean }> = [];
  const slotless: Array<{ idx: number; copy: string; slotted: boolean }> = [];
  for (let i = 0; i < pool.length; i++) {
    if (usedIndices?.has(i)) continue;
    const t = pool[i];
    const needed = templateSlots(t);
    if (needed.length === 0) {
      slotless.push({ idx: i, copy: t, slotted: false });
    } else {
      if (!slots) continue;
      const filled = fillTemplate(t, slots);
      if (filled !== null) fillable.push({ idx: i, copy: filled, slotted: true });
    }
  }

  // Prefer slotted when available.
  const preferred = fillable.length > 0 ? fillable : slotless;
  if (preferred.length === 0) {
    // Last resort: ignore the used-indices dedup and return any slotless
    // variant (we never want to emit nothing just because of dedup).
    if (pool.length === 0) return null;
    const idx = seed % pool.length;
    const t = pool[idx];
    const filled = templateSlots(t).length === 0 ? t : fillTemplate(t, slots ?? {});
    if (filled === null) return null;
    return { copy: filled, index: idx, slotted: templateSlots(t).length > 0 };
  }

  const pick = preferred[seed % preferred.length];
  return { copy: pick.copy, index: pick.idx, slotted: pick.slotted };
}
