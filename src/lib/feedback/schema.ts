/**
 * Zod schemas for the F3 feedback bundle.
 *
 * `ChecklistStateSchema` is what the CLIENT sends. Five boolean flags,
 * nothing else. The server never trusts client-provided payload data —
 * it reads its own DB keyed on `userId` + the checklist flags.
 *
 * `FeedbackBundleSchema` is a discriminated union on `version` (N6 fold
 * from the 2026-04-21 agent-accessible-feedback-pipeline proposal). Both
 * v1 and v2 are supported indefinitely; no backfill. Admin viewer and
 * agent endpoint branch on `version`.
 */

import { z } from "zod";

export const ChecklistStateSchema = z.object({
  messages: z.boolean(),
  sessions: z.boolean(),
  calendar: z.boolean(),
  errors: z.boolean(),
  console: z.boolean(),
});
export type ChecklistState = z.infer<typeof ChecklistStateSchema>;

/** 7-option enum; see proposal §4a. Intentionally mixes surface-based and
 *  action-based tags — may split into `surface`/`action` in v2 of the form. */
export const FEEDBACK_AREAS = [
  "dashboard_chat",
  "deal_room_chat",
  "link_creation",
  "meeting_editing",
  "calendar_sync",
  "confirmation_flow",
  "other",
] as const;
export const FeedbackAreaSchema = z.enum(FEEDBACK_AREAS);
export type FeedbackArea = z.infer<typeof FeedbackAreaSchema>;

export const ClientStateSchema = z
  .object({
    locationHash: z.string().nullable().optional(),
    focusedElementId: z.string().nullable().optional(),
    focusedSessionId: z.string().nullable().optional(),
    viewerTimezone: z.string().optional(),
    lastSeenMessageId: z.string().nullable().optional(),
    viewport: z
      .object({
        w: z.number().int().nonnegative(),
        h: z.number().int().nonnegative(),
      })
      .optional(),
    pendingUI: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ClientState = z.infer<typeof ClientStateSchema>;

/**
 * Host-path submission (NextAuth session). `userText` is optional as of
 * 2026-04-21 — the Haiku-prefilled gray draft submits verbatim if the user
 * doesn't type. `triedToDoText` is retained for schema back-compat with
 * any outstanding client but the new UI never populates it.
 */
export const FeedbackSubmitSchema = z.object({
  userText: z.string().max(4000).optional(),
  triedToDoText: z.string().max(4000).optional(),
  area: FeedbackAreaSchema.optional(),
  checklistState: ChecklistStateSchema,
  sessionId: z.string().max(200).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  consoleLines: z
    .array(z.string().max(2000))
    .max(100)
    .optional(),
  clientState: ClientStateSchema.optional(),
});
export type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitSchema>;

/**
 * Guest-path submission (linkCode auth, no session). Closed schema —
 * `guestName`/`guestEmail`/`filedByGuest` are explicitly NOT here because
 * they are server-derived (B1 of the decided proposal, 2026-04-21). Zod
 * `.strict()` rejects unknown keys so a malicious body that includes them
 * is rejected at the boundary.
 */
export const FeedbackSubmitAsGuestSchema = z
  .object({
    linkCode: z.string().min(1).max(200),
    userText: z.string().max(4000).optional(),
    area: FeedbackAreaSchema.optional(),
    includeContext: z.boolean(),
    sessionId: z.string().max(200).optional(),
    url: z.string().max(500).optional(),
    userAgent: z.string().max(500).optional(),
    clientState: ClientStateSchema.optional(),
  })
  .strict();
export type FeedbackSubmitAsGuestInput = z.infer<typeof FeedbackSubmitAsGuestSchema>;

const RedactedCalendarEventSchema = z.object({
  id: z.string(),
  iCalUID: z.string().optional(),
  start: z.string(),
  end: z.string(),
  summary: z.string(),
  eventType: z.string().optional(),
  isAllDay: z.boolean(),
  isRecurring: z.boolean(),
  calendarName: z.string(),
  location: z.string().optional(),
  responseStatus: z.string().optional(),
  attendees: z.object({ count: z.number().int().nonnegative() }),
  agentenvoySessionId: z.string().optional(),
});

const HeadersSchema = z.object({
  url: z.string().optional(),
  userAgent: z.string().optional(),
  appVersion: z.string().optional(),
});

const MessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  createdAt: z.string(),
  content: z.string(),
});

const MessageWithMetaSchema = z.object({
  id: z.string(),
  role: z.string(),
  createdAt: z.string(),
  content: z.string(),
  actions: z
    .array(
      z.object({
        action: z.string(),
        params: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  actionResults: z
    .array(
      z.object({
        action: z.string(),
        success: z.boolean(),
        message: z.string(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  /** Populated only for the incident turn when PROMPT_SNAPSHOT_ENABLED. */
  promptContext: z
    .object({
      systemPrompt: z.string(),
      contextBlock: z.string().optional(),
      modelId: z.string(),
      tokenCount: z.number().optional(),
    })
    .optional(),
});

const SessionSliceSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  agreedTime: z.string().nullable(),
  createdAt: z.string(),
  linkCode: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

const RecentLinkSchema = z.object({
  code: z.string(),
  slug: z.string(),
  url: z.string(),
  rulesJson: z.unknown(),
  createdAt: z.string(),
  lastEditedAt: z.string(),
});

const FilingContextSchema = z.object({
  filedAt: z.string(),
  timeSinceLastUserMsg: z.string().nullable(),
  lastAgentOutcome: z.enum(["success", "error", "action_failed", "no_action"]),
  suspectedIncidentTurn: z
    .object({
      messageId: z.string(),
      outcome: z.string(),
      userMsg: z
        .object({
          id: z.string(),
          content: z.string(),
          createdAt: z.string(),
        })
        .nullable(),
      agentMsg: z
        .object({
          id: z.string(),
          content: z.string(),
          createdAt: z.string(),
          actions: z
            .array(
              z.object({
                action: z.string(),
                params: z.record(z.string(), z.unknown()),
              }),
            )
            .optional(),
          actionResults: z
            .array(
              z.object({
                action: z.string(),
                success: z.boolean(),
                message: z.string(),
                data: z.record(z.string(), z.unknown()).optional(),
              }),
            )
            .optional(),
        })
        .nullable(),
    })
    .nullable(),
  recentFailures: z.array(
    z.object({
      messageId: z.string(),
      action: z.string(),
      failureReason: z.string(),
      at: z.string(),
    }),
  ),
});
export type FilingContext = z.infer<typeof FilingContextSchema>;

/** v1 shape — kept intact so pre-PR rows render unchanged. */
export const FeedbackBundleV1Schema = z.object({
  version: z.literal(1),
  capturedAt: z.string(),
  headers: HeadersSchema,
  messages: z.array(MessageSchema).optional(),
  sessions: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        status: z.string(),
        agreedTime: z.string().nullable(),
        createdAt: z.string(),
      }),
    )
    .optional(),
  calendar: z.array(RedactedCalendarEventSchema).optional(),
  routeErrors: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        route: z.string(),
        method: z.string().nullable(),
        errorClass: z.string().nullable(),
        message: z.string(),
      }),
    )
    .optional(),
  consoleLines: z.array(z.string()).optional(),
  sharedChannel: z
    .object({
      messages: z.array(MessageSchema),
    })
    .optional(),
  session: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      status: z.string(),
      proposedSlots: z.unknown().optional(),
      agreedTime: z.string().nullable(),
    })
    .optional(),
  link: z
    .object({
      code: z.string(),
      hostEmail: z.string().nullable(),
    })
    .optional(),
  filedByGuest: z.boolean().optional(),
  guestIdentity: z
    .object({
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .optional(),
});
export type FeedbackBundleV1 = z.infer<typeof FeedbackBundleV1Schema>;

/** v2 shape — filingContext, recent/prior segmentation, sessions with
 *  linkCode+url, optional recentLinks (host bundles only). */
export const FeedbackBundleV2Schema = z.object({
  version: z.literal(2),
  capturedAt: z.string(),
  headers: HeadersSchema,
  filingContext: FilingContextSchema,
  /** Host-path: full inbox view. Present only on host bundles. */
  messages: z
    .object({
      recentTurns: z.array(MessageWithMetaSchema),
      priorContext: z.array(MessageWithMetaSchema),
    })
    .optional(),
  /** Guest-path: scoped to the shared channel (link's session thread). */
  sharedChannel: z
    .object({
      recentTurns: z.array(MessageWithMetaSchema),
      priorContext: z.array(MessageWithMetaSchema),
    })
    .optional(),
  sessions: z.array(SessionSliceSchema).optional(),
  recentLinks: z.array(RecentLinkSchema).optional(),
  calendar: z.array(RedactedCalendarEventSchema).optional(),
  routeErrors: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        route: z.string(),
        method: z.string().nullable(),
        errorClass: z.string().nullable(),
        message: z.string(),
      }),
    )
    .optional(),
  consoleLines: z.array(z.string()).optional(),
  clientState: ClientStateSchema.optional(),
  session: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      status: z.string(),
      proposedSlots: z.unknown().optional(),
      agreedTime: z.string().nullable(),
    })
    .optional(),
  link: z
    .object({
      code: z.string(),
      hostEmail: z.string().nullable(),
    })
    .optional(),
  filedByGuest: z.boolean().optional(),
  guestIdentity: z
    .object({
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .optional(),
});
export type FeedbackBundleV2 = z.infer<typeof FeedbackBundleV2Schema>;

export const FeedbackBundleSchema = z.discriminatedUnion("version", [
  FeedbackBundleV1Schema,
  FeedbackBundleV2Schema,
]);
export type FeedbackBundle = z.infer<typeof FeedbackBundleSchema>;
