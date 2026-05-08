/**
 * Zod schemas for every MCP tool — input + output.
 *
 * Source of truth per SPEC §3.1 and parent proposal §2.7 (the eight tools).
 * The `.well-known/mcp.json` generator, the HTTP route dispatcher, and
 * response-shape tests all read from here so the wire contract can't drift
 * from the handler implementations.
 *
 * Conventions:
 *   - Inputs: strict objects (unknown keys rejected — keeps agents honest).
 *   - Outputs: permissive passthrough only where noted (reserved for
 *     future-compatible additive fields the client should ignore).
 *   - `meetingUrl` is always a string the caller provides; `auth.ts#parseMeetingUrl`
 *     normalizes it, so the schema here is `z.string().min(1)` not a strict URL.
 *     Agents happily paste relative paths (`/meet/abc`) — we accept those.
 *   - Refusal shapes follow §2 of the parent proposal: `{ok:false, reason, message}`.
 *     Each tool's output union includes its reason enum.
 *
 * Related:
 *   - `src/lib/mcp/parameter-resolver.ts` — shape of the state envelope.
 *   - `src/lib/mcp/auth.ts` — rate-limit and link-resolution reasons.
 *   - `src/lib/confirm-pipeline.ts` — `ConfirmResult` reasons reused by propose_lock.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const meetingUrlSchema = z
  .string()
  .min(1)
  .describe("The meeting URL (`/meet/<slug>?c=<code>`) or just `<slug>`.");

export const formatSchema = z.enum(["video", "phone", "in-person"]);

export const principalSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.email().optional(),
  })
  .strict()
  .describe("On whose behalf the agent is acting (EA's principal, etc).");

export const clientMetaSchema = z
  .object({
    clientName: z.string().min(1).max(200).optional(),
    clientType: z
      .enum(["human_via_ui", "envoy", "external_agent"])
      .optional()
      .default("external_agent"),
    principal: principalSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Parameter envelope (mirrors `parameter-resolver.ts`)
// ---------------------------------------------------------------------------

const parameterOrigin = z.enum([
  "link-rule",
  "host-profile-default",
  "system-default",
  "unset",
]);
const parameterMutability = z.enum([
  "locked",
  "host-filled",
  "delegated",
  "open",
  "required",
]);

const envelopeOf = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({
      value: value.nullable(),
      origin: parameterOrigin,
      mutability: parameterMutability,
      allowedValues: z.array(value).optional(),
      suggestions: z.array(value).optional(),
      // Host's single preferred value within `allowedValues`. Optional and
      // advisory. Invariant (refine below): `preferred ∈ allowedValues`
      // whenever both present; emitted only under `delegated` mutability
      // in v1 (resolver enforces that half — this schema covers the
      // invariant that prevents hand-constructed bad envelopes from
      // slipping past `get_meeting_parameters`). See proposal
      // 2026-04-20_mcp-envelope-preferred-primitive and SPEC §2.3.
      preferred: value.optional(),
      guestMustResolve: z.boolean(),
    })
    .strict()
    .refine(
      (env) => {
        if (env.preferred === undefined) return true;
        // preferred present. It must appear in allowedValues — if allowedValues
        // is absent the hint has no frame of reference and is rejected.
        if (!env.allowedValues) return false;
        return env.allowedValues.includes(env.preferred);
      },
      {
        message:
          "ParameterEnvelope invariant violated: `preferred` must be present in `allowedValues`",
        path: ["preferred"],
      },
    );

export const resolvedParametersSchema = z
  .object({
    format: envelopeOf(formatSchema),
    duration: envelopeOf(z.number().int().positive()),
    location: envelopeOf(z.string()),
    timezone: envelopeOf(z.string()),
    guestMustResolve: z.array(
      z.enum(["format", "duration", "location", "timezone"])
    ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Refusal shapes
// ---------------------------------------------------------------------------

export const authRefusalReasonSchema = z.enum([
  "link_not_found",
  "link_expired",
  "rate_limited",
]);

const refusal = <R extends z.ZodTypeAny>(reason: R) =>
  z
    .object({
      ok: z.literal(false),
      reason,
      message: z.string(),
      retryAfterSeconds: z.number().int().positive().optional(),
    })
    .strict();

// ---------------------------------------------------------------------------
// 1. get_meeting_parameters
// ---------------------------------------------------------------------------

export const getMeetingParametersInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    slotStart: z.iso.datetime().optional(),
  })
  .strict();

// Shared rules shape — appears in both `get_meeting_parameters` (top-level)
// and `get_availability` (as the optional `rules` field, recon #4 of the
// 2026-04-30 stabilization-package). Keeping it factored so the two surfaces
// can't drift.
const rulesPassthroughSchema = z
  .object({
    activity: z.string().optional(),
    activityIcon: z.string().optional(),
    timingLabel: z.string().optional(),
    // VIP classification, echoed so guest agents can explain their
    // output ("your host prioritized these times because you're a VIP").
    // Gates stretch1/stretch2 tier visibility server-side — see
    // `handleGetAvailability`. Not a secret: intentionally echoed per
    // SPEC invariant #9.
    isVip: z.boolean().optional(),
    // Structured anchor derived from `timingLabel`. Guest agents branch
    // on this without re-implementing the regex; `timingLabel` is kept
    // alongside for free-form nuance. Derivation lives in
    // `src/lib/scoring.ts#deriveTimingAnchor` (single source of truth
    // shared with the web greeting's prose opener).
    timingPreference: z
      .object({
        anchor: z.enum(["this-week", "next-week"]).nullable(),
      })
      .optional(),
    // Host's `guestPicks.window` (hour-of-day clamp), echoed so guest
    // agents can explain "why am I only seeing slots after 9am." The
    // server already applies it to the slot filter — this is the
    // context for the guest-side narration. Hours are host-tz local.
    guestPicksWindow: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(1).max(24),
      })
      .optional(),
  })
  .partial()
  .passthrough();

export const getMeetingParametersOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      meetingUrl: z.string(),
      parameters: resolvedParametersSchema,
      rules: rulesPassthroughSchema,
    })
    .strict(),
  refusal(authRefusalReasonSchema),
]);

// ---------------------------------------------------------------------------
// 2. get_availability
// ---------------------------------------------------------------------------

export const availabilitySlotSchema = z
  .object({
    /** Slot start in UTC (ISO with `Z`). */
    start: z.iso.datetime(),
    /** Slot end in UTC (ISO with `Z`). */
    end: z.iso.datetime(),
    /**
     * Same start formatted in the host's timezone, no offset suffix.
     * E.g. `"2026-05-05T09:00:00"` for a 09:00 slot in America/Los_Angeles.
     * Saves agents from doing UTC→local math just to display options.
     * Always emitted alongside `start`; `start` remains the canonical UTC value.
     * Stabilization-package §3 Group C; reconciliation #4.
     */
    localStart: z.string().optional(),
    /**
     * Slot protection score. Integer-valued by construction (every writer in
     * `scoring.ts` emits an int literal). SPEC invariant #9 documents the
     * bands: ≤ -1 host-preferred, 0–1 bookable, 2–3 VIP backup, ≥ 4 blocked
     * (never emitted). The (-1, 0) band is empty by construction.
     */
    score: z.number(),
    /**
     * Offerability tier. `first_offer` is the default bookable band (score
     * ≤ 1); `stretch1`/`stretch2` are VIP-only deeper reaches. Only emitted
     * when the link has `rules.isVip = true`.
     */
    tier: z.enum(["first_offer", "stretch1", "stretch2"]).optional(),
    /**
     * True when this slot is a host-preferred pick (score ≤ -1). Within the
     * first_offer tier, star these in UI and propose them first. Matches the
     * web greeting's `isPreferred` predicate (see `greeting-template.ts`).
     * Backward-compatible optional — absent for pre-2026-04-20 consumers.
     */
    preferred: z.boolean().optional(),
  })
  .strict();

export const getAvailabilityInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    dateRange: z
      .object({
        start: z.iso.date(),
        end: z.iso.date(),
      })
      .strict()
      .optional(),
    timezone: z
      .string()
      .optional()
      .describe(
        "Display timezone. Does NOT shift slot timestamps (those are UTC)."
      ),
    /**
     * Maximum number of slots to return. Default 20 — Town agent feedback
     * showed ~80 slots on a 7-day range produces decision fatigue and burns
     * agent tokens. Pass higher (max 200) when an agent specifically wants
     * the broader set. Slots are returned best-first (lowest score, ties
     * broken by earliest start). Stabilization-package §3 Group C; recon #5.
     */
    limit: z.number().int().min(1).max(200).optional().default(20),
    /**
     * Guest agent's own busy windows. UTC ISO datetime pairs. Slots that
     * overlap any window are excluded from the returned set so the caller
     * gets a pre-filtered list without a local subtract step.
     * Max 500 entries — a full day of 30-min blocks on a 90-day horizon.
     */
    busyWindows: z
      .array(
        z
          .object({ start: z.iso.datetime(), end: z.iso.datetime() })
          .strict()
      )
      .max(500)
      .optional(),
  })
  .strict();

export const getAvailabilityOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      timezone: z.string(),
      slots: z.array(availabilitySlotSchema),
      /**
       * The latest date John offered time through, in YYYY-MM-DD format
       * (host timezone). Tells agents "John didn't offer time after this
       * date" — the distinction between offered and available is intentional.
       * Null when the slot set is empty (nothing was offered at all).
       */
      slotsThrough: z.iso.date().nullable().optional(),
      /**
       * Resolved parameter envelope (format / duration / location / topic /
       * timezone) — same shape get_meeting_parameters returns at top level.
       * Echoed here so single-call agent flows don't need a separate
       * get_meeting_parameters round-trip when the parameters are locked
       * (the 90% case). When agents need to negotiate parameter values,
       * they can still call get_meeting_parameters for the canonical
       * envelope. Stabilization fold (Town agent feedback #4): the
       * three-call flow becomes two-call for the common case.
       */
      parameters: resolvedParametersSchema.optional(),
      /**
       * Same `rules` passthrough as get_meeting_parameters — activity,
       * activityIcon, timingLabel, isVip, timingPreference, guestPicksWindow.
       * Optional for backward compatibility; agents that didn't request it
       * (or older clients) keep working. Town agent feedback #4 fold.
       */
      rules: rulesPassthroughSchema.optional(),
    })
    .strict(),
  refusal(authRefusalReasonSchema),
]);

// ---------------------------------------------------------------------------
// 3. get_session_status
// ---------------------------------------------------------------------------

export const sessionStatusSchema = z.enum([
  "active",
  "agreed",
  "cancelled",
  "rescheduled",
  "expired",
]);

export const rescheduleHistoryEntry = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    at: z.iso.datetime(),
    actor: z.enum(["host", "guest", "host_envoy", "external_agent"]),
    reason: z.string().optional(),
  })
  .strict();

export const pendingConsentRequestSchema = z
  .object({
    id: z.string(),
    field: z.string(),
    proposedValue: z.unknown(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const getSessionStatusInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    sessionId: z.string().optional(),
  })
  .strict();

export const getSessionStatusOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      status: sessionStatusSchema,
      sessionId: z.string().nullable(),
      agreedTime: z.iso.datetime().nullable(),
      rescheduleHistory: z.array(rescheduleHistoryEntry),
      pendingConsentRequests: z.array(pendingConsentRequestSchema),
    })
    .strict(),
  refusal(
    z.enum(["link_not_found", "link_expired", "rate_limited", "session_not_found"])
  ),
]);

// ---------------------------------------------------------------------------
// 4. post_message
// ---------------------------------------------------------------------------

export const postMessageInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    text: z.string().min(1).max(4000),
    clientMeta: clientMetaSchema.optional(),
  })
  .strict();

export const postMessageOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      messageId: z.string(),
      sessionId: z.string(),
      envoyReply: z
        .object({ messageId: z.string(), text: z.string() })
        .strict()
        .optional(),
    })
    .strict(),
  refusal(
    z.enum([
      "link_not_found",
      "link_expired",
      "rate_limited",
      "guest_required",
      "session_terminal",
    ])
  ),
]);

// ---------------------------------------------------------------------------
// 5. propose_parameters
// ---------------------------------------------------------------------------

export const proposeParametersInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    sessionId: z.string().optional(),
    proposal: z
      .object({
        format: formatSchema.optional(),
        duration: z.number().int().positive().optional(),
        location: z.string().optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, {
        message: "proposal must set at least one field",
      }),
    action: z.enum(["resolve", "defer_to_host_envoy"]).optional().default("resolve"),
    clientMeta: clientMetaSchema.optional(),
  })
  .strict();

export const proposeParametersResultEntry = z
  .object({
    field: z.enum(["format", "duration", "location"]),
    accepted: z.boolean(),
    reason: z
      .enum([
        "accepted",
        "field_locked",
        "value_not_allowed",
        "deferred_to_host_envoy",
        "host_profile_incomplete",
      ])
      .optional(),
    appliedValue: z.unknown().optional(),
    decidedBy: z.enum(["guest", "host", "host_envoy"]).optional(),
    rationale: z.string().optional(),
  })
  .strict();

export const proposeParametersOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string(),
      results: z.array(proposeParametersResultEntry),
      graceWindowSeconds: z.number().int().positive().optional(),
      decidedAt: z.iso.datetime().optional(),
    })
    .strict(),
  refusal(
    z.enum([
      "link_not_found",
      "link_expired",
      "rate_limited",
      "session_not_found",
      "session_terminal",
    ])
  ),
]);

// ---------------------------------------------------------------------------
// 6. propose_lock (the handshake)
// ---------------------------------------------------------------------------

export const guestInfoSchema = z
  .object({
    email: z.email(),
    name: z.string().min(1).max(200),
    wantsReminder: z.boolean().optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const proposeLockInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    sessionId: z.string().optional(),
    slot: z
      .object({
        start: z.iso.datetime(),
        durationMinutes: z.number().int().positive().optional(),
      })
      .strict(),
    guest: guestInfoSchema,
    overrides: z
      .object({
        format: formatSchema.optional(),
        location: z.string().optional(),
      })
      .strict()
      .optional(),
    idempotencyKey: z.string().max(200).optional(),
    clientMeta: clientMetaSchema.optional(),
  })
  .strict();

export const proposeLockCounterProposalSchema = z
  .object({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    score: z.number(),
  })
  .strict();

export const proposeLockOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string(),
      /**
       * Canonical session URL with code (e.g.,
       * `https://agentenvoy.ai/meet/johnanderson/a2tztn`). Returned so
       * agents that booked via a bare-vanity URL (`/meet/<slug>`) can
       * later cancel/reschedule without digging into the calendar event
       * description to find the code. Added 2026-05-01 after a friend's
       * Claude hit `session_not_found` on cancel because it tried the
       * vanity URL it had originally booked through.
       */
      meetingUrl: z.string().optional(),
      status: z.literal("confirmed"),
      dateTime: z.iso.datetime(),
      duration: z.number().int().positive(),
      format: formatSchema,
      location: z.string().nullable(),
      meetLink: z.string().nullable().optional(),
      eventLink: z.string().nullable().optional(),
      idempotent: z.boolean().optional(),
      warnings: z.array(z.enum(["gcal_failed", "email_failed"])).optional(),
    })
    .strict(),
  refusal(
    z.enum([
      "link_not_found",
      "link_expired",
      "rate_limited",
      "validation_failed",
      "session_not_found",
      "host_email_missing",
      "host_profile_incomplete",
      "in_person_disallowed",
      "slot_mismatch",
      "slot_taken_during_handshake",
      "already_confirmed_elsewhere",
      "consent_not_accepted",
      // F3 choke-point (proposal 2026-05-04_update-time-action-state-drift §4):
      // session has a live calendarEventId from a prior confirmation; caller
      // must route through reschedule_meeting instead of propose_lock.
      "session_already_has_event",
    ])
  ).extend({
    counterProposal: z.array(proposeLockCounterProposalSchema).optional(),
  }),
]);

// ---------------------------------------------------------------------------
// 7. cancel_meeting
// ---------------------------------------------------------------------------

export const cancelMeetingInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    sessionId: z.string().optional(),
    reason: z.string().max(1000).optional(),
    notifyHost: z.boolean().optional().default(true),
    idempotencyKey: z.string().max(200).optional(),
    clientMeta: clientMetaSchema.optional(),
  })
  .strict();

export const cancelMeetingOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string(),
      status: z.literal("cancelled"),
      idempotent: z.boolean().optional(),
    })
    .strict(),
  refusal(
    z.enum([
      "link_not_found",
      "link_expired",
      "rate_limited",
      "session_not_found",
      "session_not_agreed",
      "session_terminal",
    ])
  ),
]);

// ---------------------------------------------------------------------------
// 8. reschedule_meeting
// ---------------------------------------------------------------------------

export const rescheduleMeetingInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    sessionId: z.string().optional(),
    newSlot: z
      .object({
        start: z.iso.datetime(),
        durationMinutes: z.number().int().positive().optional(),
      })
      .strict(),
    reason: z.string().max(1000).optional(),
    overrides: z
      .object({
        format: formatSchema.optional(),
        location: z.string().optional(),
      })
      .strict()
      .optional(),
    idempotencyKey: z.string().max(200).optional(),
    clientMeta: clientMetaSchema.optional(),
  })
  .strict();

export const rescheduleMeetingOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string(),
      status: z.literal("rescheduled"),
      from: z.iso.datetime(),
      to: z.iso.datetime(),
      idempotent: z.boolean().optional(),
    })
    .strict(),
  refusal(
    z.enum([
      "link_not_found",
      "link_expired",
      "rate_limited",
      "session_not_found",
      "session_not_agreed",
      "session_terminal",
      "slot_taken_during_handshake",
      // Google Calendar refused the patch — typically transient (rate
      // limits, auth-token refresh failure, network blip). Reschedule
      // breaks parity with cancel-pipeline's "log and continue" pattern:
      // a missed-cancel leaves a ghost event (recoverable), a missed-
      // reschedule sends people to the wrong time (not). On this refusal
      // the DB is untouched — agents can retry the same idempotencyKey.
      // Per proposal §B1 fold (2026-04-30).
      "gcal_patch_failed",
      // Stub tools — advertised in tools/list, not yet wired to a real
      // pipeline. Discipline: any future stub MUST return this reason;
      // do NOT reuse a state-specific reason like `session_terminal`.
      // Agents reading the wire need to distinguish "this server doesn't
      // support this yet" from "your session is closed."
      "tool_not_implemented",
    ])
  ).extend({
    counterProposal: z.array(proposeLockCounterProposalSchema).optional(),
  }),
]);

// ---------------------------------------------------------------------------
// 9. lock_activity_location
// ---------------------------------------------------------------------------

/**
 * Guest-side parity for the host-Envoy `lock_activity_location` action.
 * Per the 2026-04-22 guest-activity-location-negotiation proposal: the
 * server-side handler is a single function (`@/agent/actions#handleLockActivityLocation`).
 * The MCP tool is a new entry point to that same handler, so an external
 * agent acting on behalf of a guest can lock activity/location structurally
 * rather than routing through chat prose. See WISHLIST "lock_activity_location
 * on MCP guest-agent surface."
 *
 * One of `activity` or `location` MUST be provided — calling with neither
 * is rejected as `validation_failed`.
 */
export const lockActivityLocationInput = z
  .object({
    meetingUrl: meetingUrlSchema,
    sessionId: z.string().optional(),
    activity: z.string().min(1).max(200).optional(),
    location: z.string().min(1).max(500).optional(),
    idempotencyKey: z.string().max(200).optional(),
    clientMeta: clientMetaSchema.optional(),
  })
  .strict();
// Note: at least one of `activity` or `location` must be provided. Enforced
// in `tools.ts#handleLockActivityLocation` (returns `validation_failed`)
// rather than via .refine() on the schema, so the SDK's tool-registration
// path can still extract a ZodRawShape via .shape.

export const lockActivityLocationOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string(),
      locked: z
        .object({
          activity: z.string().nullable(),
          location: z.string().nullable(),
          /** Format derived from activity (in-person / video / phone). Null when no activity was set. */
          format: z.string().nullable(),
        })
        .strict(),
      lockedBy: z.literal("guest"),
    })
    .strict(),
  refusal(
    z.enum([
      "link_not_found",
      "link_expired",
      "rate_limited",
      "session_not_found",
      "session_terminal",
      "format_upgrade_blocked",
      "validation_failed",
    ])
  ),
]);

// ---------------------------------------------------------------------------
// Tool registry — one table that downstream code (route dispatcher,
// `.well-known/mcp.json` generator, completeness tests) reads.
// ---------------------------------------------------------------------------

export const MCP_TOOLS = {
  get_meeting_parameters: {
    input: getMeetingParametersInput,
    output: getMeetingParametersOutput,
    description:
      "Read the state envelope for every negotiable parameter on this meeting link.",
  },
  get_availability: {
    input: getAvailabilityInput,
    output: getAvailabilityOutput,
    description: "Read the host's scored, filtered slot list.",
  },
  get_session_status: {
    input: getSessionStatusInput,
    output: getSessionStatusOutput,
    description:
      "Read the current lifecycle state of a negotiation session (active / agreed / cancelled / rescheduled / expired) plus reschedule history and pending consent requests.",
  },
  post_message: {
    input: postMessageInput,
    output: postMessageOutput,
    description:
      "Post a message to the deal-room thread as role=external_agent. Streams the Host Envoy's reply.",
  },
  propose_parameters: {
    input: proposeParametersInput,
    output: proposeParametersOutput,
    description:
      "Propose values for one or more negotiable parameters. Returns per-field results so one rejection does not kill the batch.",
  },
  propose_lock: {
    input: proposeLockInput,
    output: proposeLockOutput,
    description:
      "The handshake. Validate, CAS active→agreed, dispatch calendar + emails, post the confirmation announcement.",
  },
  cancel_meeting: {
    input: cancelMeetingInput,
    output: cancelMeetingOutput,
    description:
      "CAS agreed→cancelled. Deletes the GCal event, dispatches cancellation emails, posts the cancellation announcement.",
  },
  reschedule_meeting: {
    input: rescheduleMeetingInput,
    output: rescheduleMeetingOutput,
    description:
      "In-place calendar.events.patch on the agreed event. Preserves iCalUID. Appends to rescheduleHistory, posts the reschedule announcement.",
  },
  lock_activity_location: {
    input: lockActivityLocationInput,
    output: lockActivityLocationOutput,
    description:
      "Lock the activity and/or location of a coordinating session on behalf of the guest. Mirrors the host-Envoy dialog action; server-side handler is shared. Format may be derived from the activity (e.g. coffee → in-person) and is validated against the host's downgrade ladder unless the activity is one of the host's pre-approved options.",
  },
} as const;

export type McpToolName = keyof typeof MCP_TOOLS;

/** Convenience: list of every tool name as a const tuple. */
export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as McpToolName[];
