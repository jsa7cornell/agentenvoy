/**
 * Action-input schema for `create_link` / `update_link` / `expand_link`.
 *
 * Decided in proposal 2026-04-29_link-handler-consolidation. The action layer
 * for link mutations had drifted: `handleCreateLink` accepted `guestPicks` /
 * `guestGuidance`; `handleExpandLink` rejected them. Three "needs at least
 * one field to change" gate-failures in 24 hours surfaced the structural
 * problem — both handlers were ad-hoc `if (typeof params.X === "string") ...`
 * chains with no shared contract. This module is the contract.
 *
 * The schema reuses leaf shapes (`guestPicksSchema`, `guestGuidanceSchema`,
 * `intentSchema`, `dateRangeSchema`, `blockedRangeSchema`, `availabilitySpecSchema`,
 * `preferredSpecSchema`) imported from [`./link-parameters.ts`](./link-parameters.ts) —
 * the persisted shape and the action-input shape share the same Zod objects,
 * so drift between them is impossible by construction.
 *
 * Mode-specific differences (e.g. `inviteeNames` required on create, optional
 * on update) are enforced by `parseLinkPatch(params, mode)` rather than as
 * separate schemas. Both `handleCreateLink` and `handleExpandLink` consume
 * this parser; Phase 2 of the proposal collapses them into one orchestrator.
 *
 * 2026-05-01 — `availability` + `preferred` accepted as patch fields;
 * `preferredTimeStart`, `preferredTimeEnd`, `preferredTimeWindows`,
 * `preferredDays`, `daysOfWeek`, `allowWeekends` removed (hard cut).
 * See proposal `2026-05-01_event-availability-vs-preferred-vs-calendar-scoring`.
 */

import { z } from "zod";

import {
  availabilitySpecSchema,
  preferredSpecSchema,
} from "./link-parameters";

// Leaf schemas — kept identical to the persisted shapes in
// `link-parameters.ts`. Drift between this file and that one is caught by
// the lockstep unit test in `__tests__/unit/link-patch-schema.test.ts`.
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

const dateRangeSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});

const blockedRangeSchema = z.object({
  start: z.string(),
  end: z.string(),
});

// Common to both create and update — every field is optional here.
// Required-on-create fields (`inviteeNames` OR `inviteeName`) are enforced
// by the discriminated parser below, not by this base schema.
const linkPatchBase = z
  .object({
    // Identity / lifecycle
    code: z.string().optional(),
    sessionId: z.string().optional(),
    topic: z.string().max(120).optional(),
    inviteeName: z.string().max(80).optional(),
    inviteeNames: z.array(z.string().max(80)).optional(),
    inviteeEmail: z.string().email().optional(),
    inviteeTimezone: z.string().optional(),
    hostNote: z.string().max(280).optional(),

    // Scheduling shape
    format: z.enum(["video", "phone", "in-person"]).optional(),
    duration: z.number().int().positive().optional(),
    minDuration: z.number().int().positive().optional(),
    isVip: z.boolean().optional(),
    urgency: z.enum(["asap", "this_week", "next_week", "next_two_weeks", "open"]).optional(),

    // Activity / location
    activity: z.string().max(60).optional(),
    activityIcon: z.string().max(8).optional(),
    activityOptions: z.array(z.string().max(60)).optional(),
    location: z.string().max(120).optional(),

    // Date window + range subtraction
    lastResort: z.array(z.string()).optional(),
    dateRange: dateRangeSchema.optional(),
    blockedRanges: z.array(blockedRangeSchema).max(10).optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    timingLabel: z.string().max(80).optional(),

    // Three-band availability + preferred (2026-05-01).
    // Replaces preferredTimeStart/End, preferredTimeWindows, preferredDays,
    // allowWeekends, slotOverrides, exclusiveSlots — all removed (hard cut).
    availability: availabilitySpecSchema.optional(),
    preferred: preferredSpecSchema.optional(),

    // Deferrals — accepted on BOTH create AND update (the bug this proposal fixes)
    guestPicks: guestPicksSchema.optional(),
    guestGuidance: guestGuidanceSchema.optional(),

    // Intent / steering — kept as classification field only (no scoring effect).
    intent: intentSchema.partial().optional(),
    steering: z.enum(["open", "soft", "narrow", "exclusive"]).optional(),

    // Recurrence — passthrough to the existing `parseRecurrence` validator.
    recurrence: z.unknown().optional(),

    // Series-edit param for recurring links — same passthrough rationale.
    seriesChange: z.unknown().optional(),
  })
  .passthrough(); // forward-compat: unknown fields preserved (matches linkParametersSchema)

export type LinkPatch = z.infer<typeof linkPatchBase>;

export type ParseResult =
  | { ok: true; patch: LinkPatch; mode: "create" | "update" }
  | { ok: false; reason: string };

/**
 * Validate the LLM-emitted params and return a typed patch.
 *
 *  - `mode === "create"`: at least one of `inviteeNames` or `inviteeName` is
 *    required. Other fields all optional.
 *  - `mode === "update"`: all fields optional, but the patch must contain at
 *    least one *assignable* field — otherwise the gate trips with
 *    "needs at least one field to change".
 */
export function parseLinkPatch(
  params: Record<string, unknown>,
  mode: "create" | "update",
): ParseResult {
  const parsed = linkPatchBase.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? ` (at ${issue.path.join(".")})` : "";
    return {
      ok: false,
      reason: `${issue?.message ?? "invalid patch"}${path}`,
    };
  }
  const patch = parsed.data as LinkPatch;

  if (mode === "create") {
    if (!patch.inviteeNames?.length && !patch.inviteeName) {
      return { ok: false, reason: "create_link needs at least one invitee name" };
    }
    return { ok: true, patch, mode };
  }

  // update mode — at least one assignable field.
  // Excluded keys: `code`/`sessionId` (routing only), `intent`/`steering`
  // (a bare steering update is treated as a probable LLM mistake — preserves
  // §4.7 split rule from the 2026-04-21 host-intent-steering proposal).
  // Everything else, including `availability`, `preferred`, `guestPicks`,
  // and `guestGuidance`, counts.
  const ROUTING_KEYS = new Set(["code", "sessionId"]);
  const STEERING_KEYS = new Set(["intent", "steering"]);
  const assignableKeys = Object.keys(patch).filter(
    (k) => !ROUTING_KEYS.has(k) && !STEERING_KEYS.has(k),
  );
  if (assignableKeys.length === 0) {
    return { ok: false, reason: "update_link needs at least one field to change" };
  }
  return { ok: true, patch, mode };
}

/**
 * Canonical list of patch keys — used by the schema-handler coverage test
 * (proposal §3.D, N3 fold). Failing this test means a key was added to the
 * Zod schema without a corresponding read site in `actions.ts`.
 */
export const LINK_PATCH_KEYS = [
  "code", "sessionId",
  "topic", "inviteeName", "inviteeNames", "inviteeEmail", "inviteeTimezone", "hostNote",
  "format", "duration", "minDuration", "isVip", "urgency",
  "activity", "activityIcon", "activityOptions", "location",
  "lastResort", "dateRange", "blockedRanges",
  "startTime", "timingLabel",
  "availability", "preferred",
  "guestPicks", "guestGuidance",
  "intent", "steering",
  "recurrence", "seriesChange",
] as const;

export type LinkPatchKey = typeof LINK_PATCH_KEYS[number];
