/**
 * regenerateMeetingNotesForLink — orchestration helper that fires
 * generateMeetingNotes for a link-level edit (activity / invitee change) and
 * persists the result.
 *
 * 2026-05-12 event-data-model-google-aligned-and-meeting-tip proposal (PR-2c).
 *
 * Scope:
 *   - Called from handleExpandLink (activity / invitee edits via chat or
 *     link-edit modal) and from updateConfirmedMeeting (scheduled-time edits).
 *   - Cap counter (NegotiationSession.meetingNotesRegens) lives on the most
 *     recent active session for the link. Link-level edits with no live
 *     session skip regen (no counter to increment, no card to render the
 *     tip on either).
 *   - Persists result on the LINK: parameters.generatedTip + description
 *     column. Per the proposal's reader chain, the existing meeting-tip
 *     priority 9 "generated-tip" template reads from parameters.generatedTip;
 *     description lands in GCal event body on next sync.
 *
 * Idempotency: calling this when nothing changed is safe — the cap-counter
 * still increments (which is the point — bounds expensive regen loops). To
 * avoid pointless increments, callers gate on the trigger-field test
 * (activity / time / invitee changed) BEFORE calling.
 */

import { prisma } from "@/lib/prisma";
import { generateMeetingNotes } from "@/lib/generate-meeting-notes";
import { parseLinkParameters } from "@/lib/link-parameters";
import type { Prisma } from "@prisma/client";

export type RegenerateResult =
  | { ok: true; description: string | null; tip: string | null; capped?: boolean }
  | { ok: false; reason: "no_active_session" | "link_not_found" | "no_creation_prompt" };

/**
 * Regenerate description + tip for a link, persist the result on the link.
 *
 * Returns { ok: true, ...output } when generation completed (including
 * cap-hit cases where output is null/null/capped:true).
 * Returns { ok: false, reason } when prerequisites aren't met (no active
 * session, link not found, no persisted creationPrompt) — callers should
 * treat these as silent no-ops, not errors.
 */
export async function regenerateMeetingNotesForLink(
  linkId: string,
): Promise<RegenerateResult> {
  // Pull the link + most recent active session in one query.
  const link = await prisma.negotiationLink.findUnique({
    where: { id: linkId },
    select: {
      id: true,
      userId: true,
      creationPrompt: true,
      parameters: true,
      inviteeName: true,
      sessions: {
        where: { archived: false, cancelledAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, agreedTime: true, format: true, meetingNotesRegens: true },
      },
    },
  });
  if (!link) return { ok: false, reason: "link_not_found" };

  const session = link.sessions[0];
  if (!session) return { ok: false, reason: "no_active_session" };

  if (!link.creationPrompt || link.creationPrompt.trim().length === 0) {
    return { ok: false, reason: "no_creation_prompt" };
  }

  // Pull host directives (free-text guidance shaping the tip).
  const host = await prisma.user.findUnique({
    where: { id: link.userId },
    select: { hostDirectives: true },
  });
  const hostDirectives =
    Array.isArray(host?.hostDirectives) ? (host!.hostDirectives as string[]) : [];

  const parameters = parseLinkParameters(link.parameters);
  const activity = typeof parameters.activity === "string" ? parameters.activity : "";
  const format =
    parameters.format === "in-person" ||
    parameters.format === "video" ||
    parameters.format === "phone"
      ? parameters.format
      : null;
  const location = typeof parameters.location === "string" ? parameters.location : null;

  const output = await generateMeetingNotes(
    {
      creationPrompt: link.creationPrompt,
      state: {
        activity,
        scheduledTime: session.agreedTime,
        invitee: link.inviteeName ? { name: link.inviteeName } : null,
        format,
        location,
      },
      hostDirectives,
    },
    { sessionId: session.id },
  );

  // Persist the new description + tip on the link. Both can independently
  // be null — that clears the field. Cap-hit cases (capped: true) come back
  // with null/null already, so the field clears — consistent with the
  // "renderer falls through to derived templates when null" contract.
  const linkUpdate: Prisma.NegotiationLinkUpdateInput = {
    description: output.description,
  };
  // parameters update via shallow merge — we don't want to clobber other
  // parameters fields. Merge inline.
  const nextParams: Record<string, unknown> = {
    ...parameters,
    generatedTip: output.tip,
  };
  linkUpdate.parameters = nextParams as Prisma.InputJsonValue;
  await prisma.negotiationLink.update({
    where: { id: linkId },
    data: linkUpdate,
  });

  return {
    ok: true,
    description: output.description,
    tip: output.tip,
    capped: output.capped,
  };
}
