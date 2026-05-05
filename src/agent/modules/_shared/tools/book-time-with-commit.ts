/**
 * `book_time_with_commit` — composer-callable Phase 2 commit tool.
 *
 * Wraps `handleCreateLink` + `confirmBooking` for the two-phase bookings flow.
 *
 * Phase 2 idempotency (Q3 Option A):
 *   Compute idempotency key from (callerUserId, resolved.email, slot.start,
 *   intent.durationMinutes). Short-circuit if already agreed.
 *
 * Per handoff doc §"Tool shapes" + book_time_with proposal §3.4.
 */
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { confirmBooking } from "@/lib/confirm-pipeline";
import { handleCreateLink } from "@/agent/actions";
import type { ComposerTool, ModuleContext } from "@/agent/modules/types";

const inputSchema = z.object({
  other: z
    .object({
      email: z.string().email(),
      name: z.string().optional(),
      hasAgentEnvoyAccount: z.boolean().optional(),
    })
    .strict()
    .describe("Resolved contact from resolve_contact. Must include email."),
  slot: z
    .object({
      start: z.string().describe("ISO datetime of the chosen slot start."),
      end: z.string().describe("ISO datetime of the chosen slot end."),
    })
    .strict(),
  intent: z
    .object({
      activity: z.string().min(1).max(80).optional(),
      durationMinutes: z.number().int().min(5).max(480).optional(),
      format: z.enum(["video", "phone", "in-person"]).optional(),
      topic: z.string().min(1).max(200).optional(),
      hostNote: z.string().min(1).max(280).optional(),
      location: z.string().min(1).max(300).optional(),
    })
    .strict(),
}).strict();

export type BookTimeWithCommitInput = z.infer<typeof inputSchema>;

const TOOL_DESCRIPTION = `Commit a booking after the host has chosen a slot from intersect_availability.

This is Phase 2 of the two-phase booking flow. Call ONLY after:
1. resolve_contact returned ok:true.
2. intersect_availability returned candidate slots.
3. The host picked a specific slot.

Idempotent: calling twice with the same (you, them, slot, duration) returns the existing booking.

IMPORTANT: Never skip Phase 1. Always present candidates to the host before calling this.`;

export const bookTimeWithCommit: ComposerTool<
  BookTimeWithCommitInput,
  Record<string, unknown>
> = {
  name: "book_time_with_commit",
  description: TOOL_DESCRIPTION,
  inputSchema,
  execute: async (input: BookTimeWithCommitInput, ctx: ModuleContext): Promise<Record<string, unknown>> => {
    const { other, slot, intent } = input;
    const callerUserId = ctx.user.id;
    const durationMinutes = intent.durationMinutes;

    const startDate = new Date(slot.start);
    const endDate = new Date(slot.end);
    const derivedDuration = durationMinutes ?? Math.round((endDate.getTime() - startDate.getTime()) / 60000);

    // ── Idempotency check (Q3 Option A) ─────────────────────────────────────
    const existing = await prisma.negotiationSession.findFirst({
      where: {
        hostId: callerUserId,
        guestEmail: { equals: other.email.toLowerCase().trim(), mode: "insensitive" },
        status: "agreed",
        agreedTime: startDate,
        duration: derivedDuration,
      },
      select: {
        id: true,
        link: { select: { slug: true, code: true } },
      },
    });

    if (existing) {
      const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
      const meetingUrl =
        existing.link?.code && existing.link?.slug
          ? `${baseUrl}/meet/${existing.link.slug}/${existing.link.code}`
          : `${baseUrl}/meet/unknown`;
      return {
        ok: true,
        outcome: "already_agreed",
        status: "confirmed",
        dateTime: slot.start,
        duration: derivedDuration,
        format: intent.format ?? "video",
        location: intent.location ?? null,
        emailSent: false,
        meetingUrl,
        sessionId: existing.id,
      };
    }

    // ── Mint contextual link ─────────────────────────────────────────────────
    const createLinkParams: Record<string, unknown> = {
      inviteeNames: other.name ? [other.name] : [],
      inviteeEmail: other.email,
      ...(intent.activity ? { activity: intent.activity } : {}),
      ...(durationMinutes ? { duration: durationMinutes } : {}),
      ...(intent.format ? { format: intent.format } : {}),
      ...(intent.topic ? { note: intent.topic } : {}),
      ...(intent.hostNote ? { hostNote: intent.hostNote } : {}),
      ...(intent.location ? { location: intent.location } : {}),
    };

    const createResult = await handleCreateLink(createLinkParams, callerUserId);

    if (!createResult.success) {
      return {
        ok: false,
        reason: "validation_failed",
        message: createResult.message ?? "Failed to create meeting link",
      };
    }

    const sessionId = createResult.data?.sessionId as string | undefined;
    if (!sessionId) {
      return {
        ok: false,
        reason: "validation_failed",
        message: "Link created but no session ID returned",
      };
    }

    // ── Confirm the booking ──────────────────────────────────────────────────
    const confirmResult = await confirmBooking({
      sessionId,
      dateTime: slot.start,
      duration: durationMinutes,
      format: intent.format,
      location: intent.location ?? null,
      guestEmail: other.email,
      guestName: other.name,
      userAgent: null,
    });

    if (!confirmResult.ok) {
      return {
        ok: false,
        reason: confirmResult.reason,
        message: confirmResult.message,
      };
    }

    const confirmedSession = await prisma.negotiationSession.findUnique({
      where: { id: sessionId },
      select: { link: { select: { slug: true, code: true } } },
    });
    const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
    const meetingUrl =
      confirmedSession?.link?.code && confirmedSession?.link?.slug
        ? `${baseUrl}/meet/${confirmedSession.link.slug}/${confirmedSession.link.code}`
        : `${baseUrl}/meet/unknown`;

    return {
      ...confirmResult,
      meetingUrl,
      sessionId,
    };
  },
};
