/**
 * Zod schemas for the F3 feedback bundle (2026-04-20 proposal).
 *
 * `ChecklistStateSchema` is what the CLIENT sends. Five boolean flags,
 * nothing else. The server never trusts client-provided payload data —
 * it reads its own DB keyed on `userId` + the checklist flags.
 *
 * `FeedbackBundleSchema` is what the SERVER writes to FeedbackReport.bundle.
 * Adding a field here is a schema diff reviewers see.
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

/**
 * Host-path submission (NextAuth session). `userText` is optional as of
 * 2026-04-21 — the Haiku-prefilled gray draft submits verbatim if the user
 * doesn't type. `triedToDoText` is retained for schema back-compat with
 * any outstanding client but the new UI never populates it.
 */
export const FeedbackSubmitSchema = z.object({
  userText: z.string().max(4000).optional(),
  triedToDoText: z.string().max(4000).optional(),
  checklistState: ChecklistStateSchema,
  sessionId: z.string().max(200).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  consoleLines: z
    .array(z.string().max(2000))
    .max(100)
    .optional(),
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
    includeContext: z.boolean(),
    sessionId: z.string().max(200).optional(),
    url: z.string().max(500).optional(),
    userAgent: z.string().max(500).optional(),
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

export const FeedbackBundleSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string(), // ISO
  headers: z.object({
    url: z.string().optional(),
    userAgent: z.string().optional(),
    appVersion: z.string().optional(),
  }),
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.string(),
        createdAt: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
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
  /** Guest-bundle shape (deal-room symmetry, 2026-04-21). When present,
   *  the bundle is a guest-filed report and the scope is narrower than a
   *  host bundle — channel-only messages + optional session, no calendar,
   *  no cross-session data, no RouteError. Mutually exclusive with the
   *  host-path slices above in practice (the guest bundle builder never
   *  sets calendar/routeErrors/etc.). */
  sharedChannel: z
    .object({
      messages: z.array(
        z.object({
          id: z.string(),
          role: z.string(),
          createdAt: z.string(),
          content: z.string(),
        }),
      ),
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
export type FeedbackBundle = z.infer<typeof FeedbackBundleSchema>;
