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

export const FeedbackSubmitSchema = z.object({
  userText: z.string().min(1).max(4000),
  triedToDoText: z.string().max(4000).optional(),
  checklistState: ChecklistStateSchema,
  sessionId: z.string().max(200).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  /** Console logs captured by the client. Free-text → bounded and only
   *  attached when the `console` checkbox is checked. Server truncates
   *  individual lines that exceed 1KB. Off by default in the UI. */
  consoleLines: z
    .array(z.string().max(2000))
    .max(100)
    .optional(),
});
export type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitSchema>;

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
});
export type FeedbackBundle = z.infer<typeof FeedbackBundleSchema>;
