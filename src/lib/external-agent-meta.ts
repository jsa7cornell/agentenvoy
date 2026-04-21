/**
 * Detection helpers for Stage 3 voice rules V2 + V4 of proposal
 * `2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity`.
 *
 * Two concerns:
 *   (1) V2 primer — `agentIdentity` key derivation. We prefer the
 *       `delegateSpeaker.name` on the external_agent message so primers
 *       don't re-fire when the same AI keeps speaking across the thread.
 *       Falls back to "unknown-agent" when name is missing.
 *   (2) V4 meta suppression — PR #62's `stripRendererOnlyBlocks` already
 *       strips raw `[DELEGATE_SPEAKER]...` tags. This module handles the
 *       prose narration that leaks the same semantic ("this is from
 *       another AI agent") in natural language — something the tag strip
 *       cannot catch. Intentionally narrow and conservative so we don't
 *       accidentally hide non-meta Envoy responses.
 */

/**
 * Conservative regex set — hits the specific meta-commentary shapes the
 * proposal calls out. Keep the set small; expand only on a confirmed miss
 * with a repro. Unit-tested in external-agent-meta-suppression.test.ts.
 */
const META_PATTERNS: RegExp[] = [
  // "The message above is from another AI agent ..."
  /\bfrom another (?:ai |AI )?agent\b/i,
  // "noted — scheduling on Danny's behalf"
  /\bscheduling on .*'s behalf\b/i,
  // Generic "this is another AI agent" / "this is an AI agent"
  /\bthis (?:message )?is (?:from )?(?:another|an) AI agent\b/i,
];

/**
 * Detect whether a bubble body reads as meta-commentary about an external
 * agent. Used by V4 mode-aware suppression in deal-room.tsx.
 */
export function isExternalAgentMetaNarration(content: string): boolean {
  if (!content) return false;
  return META_PATTERNS.some((rx) => rx.test(content));
}

/**
 * Derive the stable primer key for an external_agent message. Prefer the
 * named delegateSpeaker (so two distinct agents on the same thread each
 * get their own primer), fall back to `unknown-agent`.
 */
export function agentIdentityFrom(
  metadata:
    | { delegateSpeaker?: { name?: string | null } | null | undefined }
    | null
    | undefined,
): string {
  const name = metadata?.delegateSpeaker?.name;
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }
  return "unknown-agent";
}
