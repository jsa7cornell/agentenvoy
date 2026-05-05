/**
 * Dormant-return eligibility helpers.
 *
 * Introduced in PR-E (onboarding proposal §3.3). Single source of truth for
 * the Q3 guard: suppress <DormantReturnBubble> when an auto-resumed
 * PrimaryLinkFlow is in flight. Per proposal reviewer note Q3: "auto-resumed
 * PrimaryLinkFlow wins — dormant bubble must yield."
 *
 * Uses the messages-as-state-of-record invariant (per 2026-04-30 proposal):
 * the in-progress / terminal state of any flow is read from ChannelMessage
 * metadata rather than a separate DB column.
 */

/** Minimal shape of a ChannelMessage needed for flow detection. */
export interface MessageMetaSlice {
  metadata?: Record<string, unknown> | null;
}

/**
 * Returns true when a PrimaryLinkFlow or preferences-extended flow appears to
 * be in progress in the given message list — meaning the dormant bubble
 * should be suppressed.
 *
 * Logic:
 *  - Walk messages looking for any with `kind === "onboarding"` and
 *    `subkind === "primary-link-tuning"` or `subkind === "preferences-extended"`.
 *  - If found, check whether a terminal message (same subkind + `terminal: true`)
 *    also exists. If no terminal message: flow is still in progress → returns true.
 *  - If both flows are absent or both have terminal markers → returns false.
 */
export function tuningInProgress(messages: MessageMetaSlice[]): boolean {
  const hasTuning = messages.some((m) => {
    const meta = m.metadata;
    return meta?.kind === "onboarding" && meta?.subkind === "primary-link-tuning";
  });

  if (hasTuning) {
    const tuningDone = messages.some((m) => {
      const meta = m.metadata;
      return meta?.subkind === "primary-link-tuning" && meta?.terminal === true;
    });
    if (!tuningDone) return true;
  }

  const hasExtended = messages.some((m) => {
    const meta = m.metadata;
    return meta?.kind === "onboarding" && meta?.subkind === "preferences-extended";
  });

  if (hasExtended) {
    const extendedDone = messages.some((m) => {
      const meta = m.metadata;
      return meta?.subkind === "preferences-extended" && meta?.terminal === true;
    });
    if (!extendedDone) return true;
  }

  return false;
}
