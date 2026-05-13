/**
 * generateMeetingNotes — Haiku 4.5 call that produces `{description, tip}`
 * for a meeting based on the host's creation prompt + structured state.
 *
 * 2026-05-12 event-data-model-google-aligned-and-meeting-tip proposal.
 *
 * Contract:
 *   - Input: creationPrompt (verbatim host turn), structured state, host
 *     directives.
 *   - Output: { description: string | null, tip: string | null } — atomic.
 *     Both fields may independently be null when no signal in the prompt.
 *   - Cost cap: 5 invocations per session lifetime, tracked via
 *     `NegotiationSession.meetingNotesRegens` counter. When the cap is hit
 *     the function short-circuits to {null, null} and (callers) should mark
 *     `tipRegenCapped: true` in metadata for diagnostics.
 *   - Embedded-at-create: the FIRST description+tip pair is emitted INLINE
 *     by the unified agent as part of the create tool call (no separate
 *     Haiku round-trip on the highest-frequency event). This function is
 *     called only for regens on edit triggers (activity / time / invitee
 *     change).
 *   - Paraphrase discipline: prompt-only (no post-stream check in v1).
 */

import { generateObject } from "ai";
import { z } from "zod";
import { envoyModel } from "@/lib/model";
import { prisma } from "@/lib/prisma";

const MODEL_ID = "claude-haiku-4-5-20251001";
const MAX_OUTPUT_TOKENS = 400;
const TIMEOUT_MS = 8000;
const REGEN_CAP_PER_SESSION = 5;

export type GenerateMeetingNotesInput = {
  /** Verbatim host turn that triggered the create. */
  creationPrompt: string;
  /** Current meeting state — drives the regenerate-trigger semantics. */
  state: {
    activity: string;
    scheduledTime?: Date | string | null;
    invitee?: { name: string; email?: string | null } | null;
    format?: "in-person" | "video" | "phone" | null;
    location?: string | null;
    customTitle?: string | null;
  };
  /** User.hostDirectives free-text guidance. */
  hostDirectives?: string[];
};

export type GenerateMeetingNotesOutput = {
  description: string | null;
  tip: string | null;
  /** True when cap-hit short-circuited; callers should surface in metadata. */
  capped?: boolean;
};

export type GenerateMeetingNotesOpts = {
  /** Session ID for cap-tracking (Prisma update increments meetingNotesRegens). */
  sessionId: string;
};

const outputSchema = z.object({
  description: z.string().max(500).nullable(),
  tip: z.string().max(280).nullable(),
});

/**
 * Build the structured prompt for Haiku. Locked rules:
 *   - description is GUEST-SHAREABLE (lands in GCal event body). Paraphrase,
 *     don't quote. Empty/null when the host gave no agenda-shaped content.
 *   - tip is HOST-ONLY (never shown to guest). Paraphrase, don't quote.
 *     Empty/null when the host gave no host-facing nudge.
 *   - Both can independently be null. Don't fabricate.
 */
function buildPrompt(input: GenerateMeetingNotesInput): string {
  const { creationPrompt, state, hostDirectives } = input;
  const inviteeBlurb = state.invitee?.name ? `Invitee: ${state.invitee.name}` : "Invitee: (unspecified)";
  const activityBlurb = state.activity ? `Activity: ${state.activity}` : "Activity: (unspecified)";
  const formatBlurb = state.format ? `Format: ${state.format}` : "";
  const locationBlurb = state.location ? `Location: ${state.location}` : "";
  const timeBlurb = state.scheduledTime
    ? `Scheduled: ${typeof state.scheduledTime === "string" ? state.scheduledTime : state.scheduledTime.toISOString()}`
    : "";
  const titleBlurb = state.customTitle ? `Custom title: ${state.customTitle}` : "";

  const directivesBlurb = hostDirectives && hostDirectives.length > 0
    ? `\n\nHost's standing preferences:\n${hostDirectives.map((d) => `  - ${d}`).join("\n")}`
    : "";

  return [
    `The host wrote this when creating the meeting:`,
    `"""${creationPrompt}"""`,
    ``,
    `Current state:`,
    activityBlurb,
    inviteeBlurb,
    formatBlurb,
    locationBlurb,
    timeBlurb,
    titleBlurb,
    directivesBlurb,
    ``,
    `Return JSON: { "description": string|null, "tip": string|null }`,
  ].filter(Boolean).join("\n");
}

const SYSTEM_PROMPT = `You generate two short pieces of text for a meeting that's being set up:

1. **description** — what the GUEST will see in the calendar invite description. Paraphrase any agenda/context/logistics the host gave (e.g. "Parking is in the lot underneath" → "Parking available in the lot underneath."). Neutral, guest-facing wording. Use null when the host gave no agenda-shaped content — DO NOT invent context.

2. **tip** — a private nudge for the HOST only (never shown to the guest). Surface anything the host said that's a reminder for them (e.g. "remind her about parking" → "Flag the underground parking to Christine when you confirm."). Host-facing voice. Use null when the host gave no host-only nudge — DO NOT invent.

Rules:
- PARAPHRASE the host's words. Never quote verbatim — even short phrases.
- Description is at most 500 characters; tip at most 280.
- Either field may be null. Both null is fine when the host gave no shareable agenda AND no host-only nudge.
- Never echo the activity, invitee name, time, or format back — those are already on the card; description and tip add NEW signal, not restate facts.
- No emoji. No markdown. Plain text.`;

/**
 * Generate description + tip via Haiku 4.5.
 *
 * Cap-enforced: increments `NegotiationSession.meetingNotesRegens` atomically
 * before the model call. When the counter would exceed REGEN_CAP_PER_SESSION,
 * returns {null, null, capped: true} without calling the model.
 *
 * Errors (timeout, schema violation, network) return {null, null} — the
 * caller drops the regen and existing cached values stand. The "generated-tip"
 * template is silent on null, so the renderer falls through to derived/
 * fallback layers automatically.
 */
export async function generateMeetingNotes(
  input: GenerateMeetingNotesInput,
  opts: GenerateMeetingNotesOpts,
): Promise<GenerateMeetingNotesOutput> {
  // Cap enforcement — atomic increment guards against concurrent edits.
  // We `update` first (incrementing) and check the post-value; if over cap,
  // short-circuit. The counter still increments on cap-hit so telemetry can
  // see how far past cap we got.
  let postCount: number;
  try {
    const updated = await prisma.negotiationSession.update({
      where: { id: opts.sessionId },
      data: { meetingNotesRegens: { increment: 1 } },
      select: { meetingNotesRegens: true },
    });
    postCount = updated.meetingNotesRegens;
  } catch (err) {
    // Session deleted mid-flight or DB error — fail safely with nulls.
    console.warn("[generate-meeting-notes] cap counter increment failed", {
      sessionId: opts.sessionId,
      error: (err as Error).message,
    });
    return { description: null, tip: null };
  }

  if (postCount > REGEN_CAP_PER_SESSION) {
    return { description: null, tip: null, capped: true };
  }

  // Empty creationPrompt → no signal to extract; skip the model call.
  if (!input.creationPrompt || input.creationPrompt.trim().length === 0) {
    return { description: null, tip: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { object } = await generateObject({
      model: envoyModel(MODEL_ID),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(input),
      schema: outputSchema,
      abortSignal: controller.signal,
    });
    // Coerce: trim, drop empty strings to null, clip to caps.
    const description =
      typeof object.description === "string" && object.description.trim().length > 0
        ? object.description.trim().slice(0, 500)
        : null;
    const tip =
      typeof object.tip === "string" && object.tip.trim().length > 0
        ? object.tip.trim().slice(0, 280)
        : null;
    return { description, tip };
  } catch (err) {
    console.warn("[generate-meeting-notes] Haiku call failed", {
      sessionId: opts.sessionId,
      error: (err as Error).message,
    });
    return { description: null, tip: null };
  } finally {
    clearTimeout(timeout);
  }
}

export const _generateMeetingNotesConstants = {
  REGEN_CAP_PER_SESSION,
};
