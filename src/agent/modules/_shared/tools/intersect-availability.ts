/**
 * `intersect_availability` — composer-callable tool (bookings module).
 *
 * Wraps `intersectAvailability` from `@/lib/intersect-availability` as a
 * ComposerTool. Per handoff doc §"Tool shapes" + book_time_with proposal §3.2.
 *
 * Privacy contract (non-negotiable):
 *   - When mutuallyOpen: false, NOTHING in the output identifies which side blocks.
 *   - theirScore: null when the other party has no AE account (freebusy-only).
 *   - localStart is in the CALLER's timezone only. Other party's tz NOT exposed.
 */
import { z } from "zod";
import type { ComposerTool, ModuleContext } from "@/agent/modules/types";
import {
  intersectAvailability,
  type IntersectAvailabilityResult,
} from "@/lib/intersect-availability";

const otherIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ae-account"),
    userId: z.string(),
    meetSlug: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("via-freebusy-snapshot"),
    sessionId: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("via-snapshot"),
    agentJsonUrl: z.string().url(),
  }).strict(),
]);

const intentSchema = z.object({
  activity: z.string().min(1).max(80).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  format: z.enum(["video", "phone", "in-person"]).optional(),
  dateRange: z
    .object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict()
    .optional(),
}).strict();

const inputSchema = z.object({
  other: otherIdentitySchema.describe(
    "Identity of the other party. Use kind:ae-account when you have their userId + meetSlug from resolve_contact.",
  ),
  intent: intentSchema.optional().describe(
    "Meeting intent constraints. durationMinutes filters slots by minimum length.",
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max candidates to return. Default 5."),
}).strict();

export type IntersectAvailabilityInput = z.infer<typeof inputSchema>;

const TOOL_DESCRIPTION = `Find paired-score candidate meeting slots between you and another person.

Returns PairedSlot candidates sorted best-first:
  - mutuallyOpen: true slots (both calendars bookable) come first
  - yourScore + theirScore: integer scores; -1 = preferred, 0 = open, 1 = acceptable
  - theirScore: null when the other party has no AgentEnvoy account
  - localStart: slot start time in YOUR timezone only

bilateral: true means both calendars were consulted.
bilateral: false means only your calendar was scored.

Privacy: when mutuallyOpen is false, do NOT speculate about which side is blocked.`;

export const intersectAvailabilityTool: ComposerTool<
  IntersectAvailabilityInput,
  IntersectAvailabilityResult
> = {
  name: "intersect_availability",
  description: TOOL_DESCRIPTION,
  inputSchema,
  execute: async (input: IntersectAvailabilityInput, ctx: ModuleContext) => {
    return intersectAvailability({
      callerUserId: ctx.user.id,
      other: input.other,
      intent: input.intent ?? undefined,
      limit: input.limit,
    });
  },
};
