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
      guestMustResolve: z.boolean(),
    })
    .strict();

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

export const getMeetingParametersOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      meetingUrl: z.string(),
      parameters: resolvedParametersSchema,
      rules: z
        .object({
          activity: z.string().optional(),
          activityIcon: z.string().optional(),
          timingLabel: z.string().optional(),
        })
        .partial()
        .passthrough(),
    })
    .strict(),
  refusal(authRefusalReasonSchema),
]);

// ---------------------------------------------------------------------------
// 2. get_availability
// ---------------------------------------------------------------------------

export const availabilitySlotSchema = z
  .object({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    score: z.number(),
    tier: z.enum(["first_offer", "stretch1", "stretch2"]).optional(),
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
  })
  .strict();

export const getAvailabilityOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      timezone: z.string(),
      slots: z.array(availabilitySlotSchema),
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
    ])
  ).extend({
    counterProposal: z.array(proposeLockCounterProposalSchema).optional(),
  }),
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
} as const;

export type McpToolName = keyof typeof MCP_TOOLS;

/** Convenience: list of every tool name as a const tuple. */
export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as McpToolName[];
