/**
 * generateMeetingNotes — Haiku 4.5 call that produces `{description, tip}`
 * for a meeting based on the host's creation prompt + structured state.
 *
 * 2026-05-12 event-data-model-google-aligned-and-meeting-tip proposal.
 *
 * **Status: STUB (PR-2 scaffolding)**. The full Haiku integration ships in a
 * follow-up PR — it needs prompt evaluation against the cmp2qcnjy regression
 * fixture and a sample of real host turns before going live. Until then,
 * `generateMeetingNotes` returns `{description: null, tip: null}` so no code
 * paths that rely on the function are accidentally activated.
 *
 * Contract (locked for the follow-up):
 *   - Input: creationPrompt (verbatim host turn), structured state, host
 *     directives.
 *   - Output: { description: string | null, tip: string | null } — atomic.
 *     Both fields may independently be null when no signal in the prompt.
 *   - Cost cap: 5 invocations per session lifetime, tracked via
 *     `NegotiationSession.meetingNotesRegens` counter (cap-hit signaled in
 *     metadata via `tipRegenCapped: true`).
 *   - Embedded-at-create: the FIRST description+tip pair is emitted INLINE
 *     by the unified agent as part of the create tool call (no separate
 *     Haiku round-trip on the highest-frequency event). This function is
 *     called only for regens on edit triggers (activity / time / invitee
 *     change).
 *   - Paraphrase discipline: prompt-only (no post-stream check in v1).
 */

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
};

export type GenerateMeetingNotesOpts = {
  /** Session ID for cap-tracking (Prisma update increments meetingNotesRegens). */
  sessionId: string;
};

const REGEN_CAP_PER_SESSION = 5;

/**
 * Generate description + tip via Haiku 4.5.
 *
 * **STUB**: always returns nulls today. The full implementation ships in a
 * follow-up PR after prompt evaluation. See proposal §2.7 for the locked
 * contract.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
export async function generateMeetingNotes(
  _input: GenerateMeetingNotesInput,
  _opts: GenerateMeetingNotesOpts,
)
/* eslint-enable @typescript-eslint/no-unused-vars */: Promise<GenerateMeetingNotesOutput> {
  // PR-2 scaffolding: stub returns null/null so the field reads cleanly but
  // no production code path is accidentally activated. The follow-up PR will:
  //   1. Check `NegotiationSession.meetingNotesRegens` < REGEN_CAP_PER_SESSION
  //      (short-circuit returning cached values otherwise + setting
  //      `tipRegenCapped: true` in metadata).
  //   2. Call Haiku 4.5 with a system prompt that instructs paraphrase
  //      (not quote), description = guest-shareable agenda/context, tip =
  //      host-only nudge.
  //   3. Parse `{description, tip}` from the response.
  //   4. Increment the cap counter via prisma.negotiationSession.update.
  //   5. Return the pair.
  return { description: null, tip: null };
}

export const _generateMeetingNotesConstants = {
  REGEN_CAP_PER_SESSION,
};
