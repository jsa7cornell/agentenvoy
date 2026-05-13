/**
 * Typed parse for `NegotiationLink.parameters` Json column.
 *
 * Phase 6 PR-C2 of the v2 refactor (CODEBASE-CLEANUP item 12 cont.). Replaces
 * the ad-hoc `parseLinkParameters(link.parameters)` pattern at
 * every read site with a Zod-validated parse. Fail-soft: schema-failures log
 * a warning and return `{}` so a malformed row never 500s a route — this
 * matches PROJECT-PLAN §6's best-effort-coercion mitigation.
 *
 * `.passthrough()` preserves any unknown fields. New parameters can be added
 * to the JSON without a schema change first; the type definition tightens
 * incrementally as fields stabilize.
 *
 * The `LinkParameters` TS interface in `scoring.ts` remains the canonical
 * shape for *consumers* (it carries field-level JSDoc); this Zod schema is its
 * runtime validator. They must stay in sync — adding a field to the interface
 * means adding it here.
 *
 * 2026-05-01 — `availability` + `preferred` introduced; `preferredTimeStart`,
 * `preferredTimeEnd`, `preferredTimeWindows`, `preferredDays`, `allowWeekends`,
 * `slotOverrides`, `exclusiveSlots` removed (hard cut). See proposal
 * `2026-05-01_event-availability-vs-preferred-vs-calendar-scoring`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Reusable leaf shapes — exported so future User-level defaults and
// guest-side composition surfaces can compose them without redesign.
// (Per proposal §Architecture "Cross-surface reuse — why the standalone
// types matter".)
// ---------------------------------------------------------------------------

export const dayNameSchema = z.enum([
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
]);
export type DayName = z.infer<typeof dayNameSchema>;

/**
 * One offerable window for a link — Layer 1 (Canvas) of the four-layer model.
 *
 * `days`         ISO weekday numbers 0=Sun..6=Sat
 * `startMinutes` minute-of-day start, 0..1440
 * `endMinutes`   minute-of-day end, 0..1440; must be > startMinutes
 *
 * Simple case:  `[{ days:[1,2,3,4,5], startMinutes:540, endMinutes:1020 }]`  Mon–Fri 9–5
 * Advanced:     `[{days:[1],540,1020}, {days:[2],540,720}, {days:[2],840,1020}]`  Mon 9–5 + Tue split
 */
export const availabilityWindowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  startMinutes: z.number().int().min(0).max(1439),
  endMinutes: z.number().int().min(1).max(1440),
}).refine(w => w.endMinutes > w.startMinutes, {
  message: "endMinutes must be greater than startMinutes",
});

export type AvailabilityWindow = z.infer<typeof availabilityWindowSchema>;

export const timeWindowSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, "HH:MM 24-hour format"),
  end: z.string().regex(/^\d{2}:\d{2}$/, "HH:MM 24-hour format"),
});

export const slotInstanceSchema = z.object({
  start: z.string(), // ISO 8601 datetime with offset
  end: z.string(),
  label: z.string().optional(),
});

/**
 * Event-availability layer — defines what THIS link makes bookable,
 * additively or restrictively relative to the host's calendar
 * availability. Can be ≥ or ≤ calendar availability.
 */
export const availabilitySpecSchema = z
  .object({
    /**
     * Additively extends what's offerable beyond the host's normal
     * calendar availability (off-hours, weekends, etc.). Each entry
     * scopes to specific days, a time window, or both. At least one
     * of `days` or `window` must be present per entry.
     */
    expand: z
      .array(
        z
          .object({
            days: z.array(dayNameSchema).optional(),
            window: timeWindowSchema.optional(),
          })
          .refine((e) => !!e.days?.length || !!e.window, {
            message: "expand entry needs at least one of `days` or `window`",
          }),
      )
      .max(10)
      .optional(),

    /** Narrows the offerable set to ONLY these days. */
    restrictToDays: z.array(dayNameSchema).optional(),

    /** Narrows the offerable set to ONLY these per-day windows. */
    restrictToWindows: z.array(timeWindowSchema).max(10).optional(),

    /**
     * Narrows the offerable set to ONLY these specific instances.
     * Replaces legacy `slotOverrides[score: -2]` + `exclusiveSlots`.
     */
    restrictToSlots: z.array(slotInstanceSchema).max(50).optional(),

    /**
     * Excludes these specific instances from the offerable set.
     * Replaces legacy `slotOverrides[score: 5]`. Composes with
     * `blockedRanges` (range subtraction) — this is the named singular
     * form for "this specific slot is out."
     */
    blockedSlots: z.array(slotInstanceSchema).max(50).optional(),
  })
  .strict();

export type AvailabilitySpec = z.infer<typeof availabilitySpecSchema>;

/**
 * Preferred layer — decoration only. Picker shows everything available;
 * greeting + MCP `slot.preferred` flag indicate which subset the host
 * most prefers. Slots NOT in `preferred` remain fully offerable.
 */
export const preferredSpecSchema = z
  .object({
    days: z.array(dayNameSchema).optional(),
    windows: z.array(timeWindowSchema).max(10).optional(),
    /**
     * Specific pinned instances. Replaces legacy `slotOverrides[score: -1]`.
     * Pin-as-preference is structurally identical to pattern-as-preference;
     * unifying here means the MCP `slot.preferred` derivation is one
     * predicate over three sources, no special cases.
     */
    slots: z.array(slotInstanceSchema).max(50).optional(),
  })
  .strict();

export type PreferredSpec = z.infer<typeof preferredSpecSchema>;

// ---------------------------------------------------------------------------
// Other leaf shapes (link-internal — not exported for cross-surface reuse).
// ---------------------------------------------------------------------------

const guestPicksSchema = z.object({
  window: z
    .object({
      startHour: z.number(),
      endHour: z.number(),
    })
    .optional(),
  date: z.boolean().optional(),
  duration: z.union([z.boolean(), z.array(z.number())]).optional(),
  location: z.boolean().optional(),
  format: z
    .union([z.boolean(), z.array(z.enum(["video", "phone", "in-person"]))])
    .optional(),
});

const guestGuidanceSchema = z.object({
  suggestions: z
    .object({
      locations: z.array(z.string()).optional(),
      durations: z.array(z.number()).optional(),
    })
    .optional(),
  tone: z.string().optional(),
  preferredFormat: z.enum(["video", "phone", "in-person"]).optional(),
});

const intentSchema = z.object({
  steering: z.enum(["open", "soft", "narrow", "exclusive"]),
});

const conditionalRuleSchema = z.object({
  condition: z.string(),
  rule: z.string(),
});

const dateRangeSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});

/**
 * One-off datetime ranges to subtract from offerable slots for THIS link.
 *
 * Decided in proposal 2026-04-28_event-edit-handler-and-composer (§3.5).
 * Example use: host says "evenings work, except Thursday evening" — composer
 * resolves "Thursday" to the specific date in the link's `dateRange` and
 * emits a single `blockedRanges` entry with absolute ISO datetimes (host TZ
 * with offset).
 *
 * NOT a recurring per-day-of-week pattern. NOT to be confused with
 * `availability.blockedSlots` (named singular slot exclusions, often pinned
 * to specific 30-min slots) — `blockedRanges` is for arbitrary range
 * subtraction within a `dateRange`.
 *
 * The slot generation pipeline subtracts these in the same pass that
 * subtracts calendar busy events.
 */
const blockedRangeSchema = z.object({
  start: z.string(), // ISO 8601 with offset, e.g. "2026-04-30T17:00:00-07:00"
  end: z.string(),
});

/**
 * V1.5 posture fields — see proposal
 * `2026-05-02_per-link-config-storage-and-scoring-link-scope`. These move
 * host-level scheduling posture (hours/days/buffer/compiled rules/evenings)
 * onto the link itself, so each variance link is independently scored.
 * All fields optional in the schema for backwards-compat during the
 * deploy window; `getLinkPosture` (lib/links/posture.ts) validates
 * completeness on read for variance links.
 */

/** Compiled-rule shapes mirror scoring.ts. No `.passthrough()` here —
 * the outer `linkParametersSchema` already does that for the whole blob,
 * and adding it on inner objects produces a type wider than Prisma's
 * `InputJsonValue` accepts at write sites. */
const compiledBufferSchema = z.object({
  beforeMinutes: z.number(),
  afterMinutes: z.number(),
  eventFilter: z.string(),
});

const compiledPriorityBucketSchema = z.object({
  level: z.enum(["high", "low"]),
  keywords: z.array(z.string()),
});

const allowWindowSchema = z.object({
  start: z.string(), // "HH:MM" 24-hour
  end: z.string(),
  days: z.array(z.string()).optional(),
  label: z.string().optional(),
  expires: z.string().optional(),
});

const compiledRulesSchema = z.object({
  buffers: z.array(compiledBufferSchema).optional(),
  priorityBuckets: z.array(compiledPriorityBucketSchema).optional(),
  allowWindows: z.array(allowWindowSchema).optional(),
  ambiguities: z.array(z.string()).optional(),
});

const eveningsPostureSchema = z.enum(["protected", "vip_only", "open"]);

/**
 * Zod schema mirroring `LinkParameters` in `scoring.ts`. `.passthrough()`
 * preserves unknown fields so forward-compat changes don't require a
 * schema bump before the value is persisted.
 */
export const linkParametersSchema = z
  .object({
    format: z.string().optional(),
    conditionalRules: z.array(conditionalRuleSchema).optional(),
    lastResort: z.array(z.string()).optional(),
    blockedRanges: z.array(blockedRangeSchema).max(10).optional(),
    dateRange: dateRangeSchema.optional(),
    isVip: z.boolean().optional(),
    duration: z.number().optional(),
    minDuration: z.number().optional(),
    guestPicks: guestPicksSchema.optional(),
    guestGuidance: guestGuidanceSchema.optional(),
    location: z.string().optional(),
    activity: z.string().optional(),
    activityIcon: z.string().optional(),
    activityOptions: z.array(z.string()).optional(),
    timingLabel: z.string().optional(),
    intent: intentSchema.optional(),

    // 2026-05-01 — three-band model (preferred layer unchanged).
    preferred: preferredSpecSchema.optional(),

    // 2026-05-06 — PR-B canvas collapse. Layer 1 of the four-layer model.
    // Replaces flat hoursStartMinutes/hoursEndMinutes/daysOfWeek + AvailabilitySpec.
    // See proposal 2026-05-06_link-config-canonical-model-and-unified-edit.
    // Union accepts both new AvailabilityWindow[] and legacy AvailabilitySpec object
    // so existing prod links are not broken during the migration window.
    availability: z.union([z.array(availabilityWindowSchema), availabilitySpecSchema]).optional(),

    // 2026-05-02 — V1.5 per-link posture fields (kept as deprecated for
    // transition window — backfill script converts these to availability[]).
    // Do not write these fields on new links; getLinkPosture reads them as
    // fallback when availability[] is absent.
    /** @deprecated Use availability[] instead. Kept for transition-window reads. */
    hoursStartMinutes: z.number().int().min(0).max(1440).optional(),
    /** @deprecated Use availability[] instead. */
    hoursEndMinutes: z.number().int().min(0).max(1440).optional(),
    /** @deprecated Use availability[] instead. */
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    bufferMinutes: z.number().int().min(0).optional(),
    eveningsPosture: eveningsPostureSchema.optional(),
    compiled: compiledRulesSchema.optional(),

    // 2026-05-10 — PR4 host-authored tip (link-edit-modal). Surfaced verbatim
    // in the MeetingCard tip slot and (post PR3) in the EnvoyDock thread.
    // Max 280 chars matches the textarea cap in link-edit-modal.
    //
    // 2026-05-12 event-data-model proposal (PR-2b): semantic shift —
    // `parameters.tip` is now RESERVED for host pencil-edit writes. The
    // LLM-emitted tip (formerly written here) now lands on
    // `parameters.generatedTip` (priority-9 template). Existing rows with
    // their LLM-seed in `tip` continue to render at priority 11 until host
    // pencil-edits or PR-3 migrates them.
    tip: z.string().max(280).optional(),

    // 2026-05-12 event-data-model proposal (PR-2b): LLM-emitted tip from
    // create-time tool emission or follow-up generateMeetingNotes (Haiku 4.5)
    // regeneration. Priority-9 template `generated-tip` reads from here.
    // Nullable: explicit `null` after host clears via update_link; absent
    // for legacy rows. Max 280 mirrors the host-authored cap.
    generatedTip: z.string().max(280).nullable().optional(),
  })
  .passthrough();

export type ParsedLinkParameters = z.infer<typeof linkParametersSchema>;

/**
 * Parse a `NegotiationLink.parameters` Json column value into a typed
 * shape. Fail-soft: returns `{}` on null/undefined/non-object input or
 * Zod schema failure, with a warning log carrying the issue summary so
 * malformed rows surface in production logs without 500-ing the route.
 *
 * Use this at every read site instead of the legacy
 * `parseLinkParameters(link.parameters)` cast.
 */
export function parseLinkParameters(input: unknown): ParsedLinkParameters {
  if (input == null || typeof input !== "object") return {};
  const result = linkParametersSchema.safeParse(input);
  if (result.success) return result.data;
  console.warn("[link-parameters] schema parse failed", {
    issues: result.error.flatten(),
  });
  return {};
}
