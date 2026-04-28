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
 * The `LinkParameters` TS interface in `scoring.ts:1426` remains the canonical
 * shape for *consumers* (it carries field-level JSDoc); this Zod schema is its
 * runtime validator. They must stay in sync — adding a field to the interface
 * means adding it here. CI grep for new `link.parameters` reads outside the
 * `parseLinkParameters()` callsite would be a future hardening (Rule 19-style).
 */

import { z } from "zod";

// Bare-leaf shapes used inside LinkParameters.
const slotOverrideSchema = z.object({
  start: z.string(),
  end: z.string(),
  score: z.number(),
  label: z.string().optional(),
});

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

const timeWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
});

/**
 * Zod schema mirroring `LinkParameters` in `scoring.ts`. `.passthrough()`
 * preserves unknown fields so forward-compat changes (e.g. wishlist `slotGrain`)
 * don't require a schema bump before the value is persisted.
 */
export const linkParametersSchema = z
  .object({
    format: z.string().optional(),
    conditionalRules: z.array(conditionalRuleSchema).optional(),
    preferredDays: z.array(z.string()).optional(),
    lastResort: z.array(z.string()).optional(),
    preferredTimeStart: z.string().optional(),
    preferredTimeEnd: z.string().optional(),
    preferredTimeWindows: z.array(timeWindowSchema).optional(),
    dateRange: dateRangeSchema.optional(),
    slotOverrides: z.array(slotOverrideSchema).optional(),
    exclusiveSlots: z.boolean().optional(),
    isVip: z.boolean().optional(),
    allowWeekends: z.boolean().optional(),
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
  // Log + return the partial-coerced result. .passthrough() means the success
  // path is the common case; failures here are genuinely-malformed rows and
  // we want to know about them.
  console.warn("[link-parameters] schema parse failed", {
    issues: result.error.flatten(),
  });
  return {};
}
